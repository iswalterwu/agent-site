"""spec_check v0.7.1

用途：只检查能力规格里的要求编号是否完整一致、代码和测试引用的编号是否存在，不要求写满任何字段；
在 feat/<功能> 分支上，卡提交之前不许改代码（提交草稿的那次提交除外；卡提交之前，草稿删掉的编号还被引用也放行）。
在研功能的卡（specs/）不参与检查：要求直接写在能力规格里。
用法：python spec_check.py [--root DIR] [--json] [--report] [--ignore GLOB]... [--ignore-rule RULE]...
输出：每个问题一行；没有问题时打印一行"通过"和能力规格、要求的数量。--list-rules 列出每条规则查什么。
退出码：0 无错误；1 有错误；2 根目录不存在或参数错误。
--report 先给出要求总数和有测试、靠演示、都没有的各几条，再列出未被测试引用和标为演示的要求，不影响退出码。
旧编号（AC-xxx-y）也算在内：测试里写成 <代号>:AC-xxx-y 才算引用。
测试引用按 test/tests/__tests__ 目录或常见测试文件名识别；普通源码不算证明。
--json --report 将报告写到标准错误，标准输出保持 JSON 数组。
本文件来自 dev-circuit-ultra 仓库，项目里不要修改，升级时整体覆盖。

认的写法（不强制某一种 Markdown 形状）：
  文件头        代号：DEMO / Code: DEMO / capability: DEMO
  要求          - DEMO-1：… / * DEMO-1: … / + DEMO-1：… / 1. DEMO-1：… / | DEMO-1 | … |
忽略白名单：--ignore GLOB、项目根目录的 .dcuignore、--ignore-rule RULE。
"""

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import NamedTuple


VERSION = "0.7.1"
IGNORE_FILE = ".dcuignore"

RULES = (
    "bad-header",
    "dup-id",
    "dangling-ref",
    "code-before-design",
)

SKIPPED_DIRS = frozenset({
    ".git", "node_modules", "dist", "build", ".venv", "venv",
    "__pycache__", ".pytest_cache",
})
# The vendored guards describe the accepted formats, so their own examples must
# not count as references to project requirements.
VENDORED_GUARDS = frozenset({"scripts/doc_guard.py", "scripts/spec_check.py"})
# What `devcircuit hooks install` leaves in the project: tooling, not the feature's code.
INSTALLED_HOOKS = frozenset({".dev-circuit/hooks/ledger_guard.py", ".pi/extensions/ledger-guard.js"})
ARCHITECTURE = "docs/architecture.md"
CODE_EXTENSIONS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue",
    ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".sh", ".ps1",
})
BULLET = r"^(?:[-*+]|\d+[.)])\s+"
IDENTIFIER = r"(?:[A-Z]{2,8}-\d+|AC-\d{3}-\d+)"
HEADER_PREFIX = re.compile(r"^(?i:代号|code|capability)\s*[：:]")
HEADER = re.compile(r"^(?i:代号|code|capability)\s*[：:]\s*([A-Z]{2,8})\s*$")
DEFINITION = re.compile(BULLET + r"(?:\*\*)?(" + IDENTIFIER + r")(?:\*\*)?\s*[：:]\s*")
TABLE_DEFINITION = re.compile(r"^\|\s*(?:\*\*)?(" + IDENTIFIER + r")(?:\*\*)?\s*\|")
DEMONSTRATION = re.compile(r"^\s+- (?:证明[：:].*演示|demonstrated by[：:])")
FEATURE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# What --list-rules prints; the scope is built from the constants above so it cannot drift from them.
RULE_HELP = {
    "bad-header": "能力规格没有恰好一行文件头“代号：<CODE>”（CODE 为 2–8 个大写字母，也认 Code: / capability:），"
                  "代号在别的能力规格里已用过，或要求编号的前缀和本文件代号不符",
    "dup-id": "同一个要求编号定义了不止一次（跨文件也算）",
    "dangling-ref": "代码或测试里引用的要求编号（前缀是已声明的代号），在能力规格里不存在；"
                    "feat/<功能> 的卡提交之前，草稿删掉的编号还被引用不算，卡提交之后要随代码改掉",
    "code-before-design": "在 feat/<功能> 分支上改了代码（已暂存、未暂存或未跟踪），但 specs/<功能>/spec.md 还没提交；"
                          "只在有 specs/ 目录的 git 仓库里查；devcircuit 装的 hook 脚本不算代码，"
                          "只提交 docs/architecture.md 的框架提交放行",
}
SCOPE = ("范围：docs/requirements/ 下除 README.md 外的 .md；引用在这些后缀的文件里找："
         + " ".join(sorted(CODE_EXTENSIONS))
         + "。--report 只把测试文件里的引用算作有测试：test/、tests/、__tests__/ 下的文件，"
           "或文件名形如 test_*、*_test、*.test.*、*.spec.*、*Test、*Tests、*Spec。")


@dataclass(frozen=True)
class Finding:
    rule: str
    path: str
    line: int
    message: str


@dataclass(frozen=True)
class _Requirement:
    id: str
    path: str
    line: int


def _fold(value: str) -> str:
    """Windows paths are case-insensitive, POSIX paths are not."""
    return value.casefold() if os.name == "nt" else value


def _plain(pattern: str) -> str:
    """Drop a leading "./" or "/"; a dot that starts a name (".github") stays."""
    while pattern.startswith("./"):
        pattern = pattern[2:]
    return pattern.lstrip("/")


def path_is_ignored(relative: str, patterns) -> bool:
    """Match a posix relative path against ignore globs (see doc_guard for rules)."""
    candidate = _fold(relative.replace("\\", "/").strip("/"))
    for raw in patterns:
        pattern = _fold(_plain(str(raw).replace("\\", "/").strip()))
        if not pattern:
            continue
        if "/" in pattern:
            if fnmatch.fnmatchcase(candidate, pattern):
                return True
            prefix = pattern.rstrip("/")
            if candidate == prefix or candidate.startswith(prefix + "/"):
                return True
        else:
            if fnmatch.fnmatchcase(candidate, pattern):
                return True
            if any(fnmatch.fnmatchcase(part, pattern) for part in candidate.split("/")):
                return True
    return False


def load_ignore_file(path: Path) -> list[str]:
    patterns: list[str] = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        entry = line.strip()
        if entry and not entry.startswith("#"):
            patterns.append(entry)
    return patterns


def _ignores(root: Path, ignores, ignore_file, use_ignore_file: bool) -> list[str]:
    patterns = list(ignores)
    if use_ignore_file:
        candidate = Path(ignore_file) if ignore_file else root / IGNORE_FILE
        if candidate.is_file():
            patterns.extend(load_ignore_file(candidate))
    return patterns


def _capability_files(root: Path, patterns=()):
    for path in sorted((root / "docs" / "requirements").glob("*.md")):
        if path.name != "README.md" and not path_is_ignored(path.relative_to(root).as_posix(), patterns):
            yield path


def _requirements(root: Path, patterns=()):
    findings: list[Finding] = []
    codes: dict[str, str] = {}
    requirements: dict[str, _Requirement] = {}
    legacy: set[str] = set()
    demonstrations: set[str] = set()
    for path in _capability_files(root, patterns):
        relative = path.relative_to(root).as_posix()
        lines = path.read_text(encoding="utf-8-sig").splitlines()
        headers = [(number, line) for number, line in enumerate(lines, 1)
                   if HEADER_PREFIX.match(line)]
        code = None
        if len(headers) == 1 and (match := HEADER.fullmatch(headers[0][1])):
            code = match.group(1)
            if code in codes:
                findings.append(Finding("bad-header", relative, headers[0][0],
                                        f"代号重复：{code}（已在 {codes[code]} 声明）"))
            else:
                codes[code] = relative
        else:
            findings.append(Finding("bad-header", relative, headers[0][0] if headers else 1,
                                    "文件头须有一个代号，由 2–8 个大写字母组成"))

        file_legacy: set[str] = set()
        current = None
        for number, line in enumerate(lines, 1):
            match = DEFINITION.match(line) or TABLE_DEFINITION.match(line)
            if match:
                identifier = match.group(1)
                current = None
                if identifier.startswith("AC-") and identifier.count("-") == 2:
                    if identifier in file_legacy:
                        findings.append(Finding("dup-id", relative, number, f"编号重复：{identifier}"))
                    file_legacy.add(identifier)
                    if code:
                        current = f"{code}:{identifier}"  # cited as <CODE>:AC-xxx-y, so counted that way
                        legacy.add(current)
                else:
                    current = identifier
                    if identifier.split("-", 1)[0] != code:
                        findings.append(Finding("bad-header", relative, number,
                                                f"编号代号与文件头不符：{identifier}"))
                    if identifier in requirements:
                        findings.append(Finding("dup-id", relative, number, f"编号重复：{identifier}"))
                    else:
                        requirements[identifier] = _Requirement(identifier, relative, number)
            elif current and DEMONSTRATION.match(line):
                demonstrations.add(current)
            elif line and not line[0].isspace():
                current = None
    return findings, codes, requirements, legacy, demonstrations


def _references(root: Path, codes, patterns=()):
    if not codes:
        return
    alternation = "|".join(re.escape(code) for code in sorted(codes))
    pattern = re.compile(
        r"\b(?:" + alternation + r")-\d+\b"                # DEMO-1
        + r"|\b(?:" + alternation + r"):AC-\d{3}-\d+\b"      # legacy <CODE>:AC-xxx-y
    )
    for directory, dirs, files in os.walk(root):
        base = Path(directory)
        dirs[:] = sorted(
            name for name in dirs
            if name not in SKIPPED_DIRS
            and not path_is_ignored((base / name).relative_to(root).as_posix(), patterns)
        )
        for name in sorted(files):
            path = base / name
            if path.suffix.lower() not in CODE_EXTENSIONS:
                continue
            relative = path.relative_to(root).as_posix()
            if relative in VENDORED_GUARDS or path_is_ignored(relative, patterns):
                continue
            for number, line in enumerate(
                    path.read_text(encoding="utf-8-sig", errors="ignore").splitlines(), 1):
                for match in pattern.finditer(line):
                    yield path.relative_to(root), number, match.group()


def _is_test(path: Path) -> bool:
    return (
        any(part.lower() in {"test", "tests", "__tests__"} for part in path.parts[:-1])
        or path.stem.startswith("test_")
        or path.stem.endswith(("_test", ".test", ".spec", "Test", "Tests", "Spec"))
    )


def _git_lines(root: Path, *args: str) -> list[str] | None:
    try:
        # core.quotepath=false: by default git prints non-ASCII paths quoted and octal-escaped, and then
        # neither the suffix nor the path matches anything.
        result = subprocess.run(["git", "-c", "core.quotepath=false", "-C", str(root), *args],
                                capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError:
        return None
    return result.stdout.splitlines() if result.returncode == 0 else None


def _draft_removals(root: Path, patterns=()) -> set[str]:
    """IDs defined at HEAD while feat/<name> has a card that is drafted but not committed: the draft may remove them.

    The design commit holds only the specs and the card, so tests and code still cite a removed ID when it
    is made. Those citations are cleaned up in the first code commit, when HEAD no longer defines the ID.
    Without a card being drafted there is no such commit to come, so nothing is tolerated.
    """
    if not (root / "specs").is_dir():
        return set()
    branch = _git_lines(root, "symbolic-ref", "--short", "-q", "HEAD")
    if not branch or not branch[0].startswith("feat/"):
        return set()
    feature = branch[0][len("feat/"):]
    if (not FEATURE_NAME.match(feature) or not (root / "specs" / feature / "spec.md").is_file()
            or _git_lines(root, "cat-file", "-e", f"HEAD:./specs/{feature}/spec.md") is not None):
        return set()
    identifiers: set[str] = set()
    # The same files _capability_files reads: direct children of docs/requirements, minus README and ignores.
    for name in _git_lines(root, "ls-tree", "--name-only", "HEAD", "docs/requirements/") or []:
        if not name.endswith(".md") or name.rsplit("/", 1)[-1] == "README.md" or path_is_ignored(name, patterns):
            continue
        lines = [line.lstrip(chr(0xFEFF)) for line in _git_lines(root, "show", f"HEAD:./{name}") or []]
        code = next((match.group(1) for line in lines if (match := HEADER.fullmatch(line))), None)
        for line in lines:
            match = DEFINITION.match(line) or TABLE_DEFINITION.match(line)
            if not match:
                continue
            identifier = match.group(1)
            if not (identifier.startswith("AC-") and identifier.count("-") == 2):
                identifiers.add(identifier)
            elif code:
                identifiers.add(f"{code}:{identifier}")  # legacy IDs are cited as <CODE>:AC-xxx-y
    return identifiers


def _design_gate(root: Path, patterns) -> list[Finding]:
    """On feat/<name>, code changes need the committed card: drafts are committed once the design is settled."""
    if not (root / "specs").is_dir():
        return []
    branch = _git_lines(root, "symbolic-ref", "--short", "-q", "HEAD")
    if not branch or not branch[0].startswith("feat/"):
        return []
    feature = branch[0][len("feat/"):]
    staged = set(_git_lines(root, "diff", "--cached", "--name-only", "--relative") or [])
    changed = set(staged)
    for args in (("diff", "--name-only", "--relative"), ("ls-files", "--others", "--exclude-standard")):
        changed.update(_git_lines(root, *args) or [])
    code = sorted(path for path in changed
                  if Path(path).suffix.lower() in CODE_EXTENSIONS
                  and path not in VENDORED_GUARDS and path not in INSTALLED_HOOKS
                  and not path_is_ignored(path, patterns))
    if not code:
        return []
    if not FEATURE_NAME.match(feature):
        return [Finding("code-before-design", "specs/", 0,
                        f"分支 {branch[0]} 对不上卡：功能名只用字母、数字、点、下划线和连字符，一段，不含斜杠；"
                        "改用 feat/<功能名>，卡放在 specs/<功能名>/spec.md")]
    card = f"specs/{feature}/spec.md"
    if _git_lines(root, "cat-file", "-e", f"HEAD:./{card}") is not None:  # committed, so the design is settled
        return []
    if not staged.intersection(code) and _git_lines(root, "cat-file", "-e", f":./{card}") is not None:
        return []  # the design commit itself: the card is staged and no code is
    if not staged.intersection(code) and ARCHITECTURE in staged:
        return []  # the framework commit: it comes before the card exists, and holds no code either
    return [Finding("code-before-design", card, 0,
                    f"分支 feat/{feature} 上改了 {len(code)} 个代码文件（如 {code[0]}），但卡还没提交（或已经收尾删掉）："
                    "定了之前只写能力规格和卡的草稿；用户说“定了”之后先单独提交设计，再写代码。"
                    "修 bug 或不属于这个功能的改动不放在 feat/ 分支上（bug 用 fix/<名>）")]


def scan(root: Path, ignores=(), ignored_rules=(), ignore_file=None,
         use_ignore_file: bool = True) -> list[Finding]:
    """Check declared IDs and the references in source files."""
    root = Path(root)
    return _scan(root, _ignores(root, ignores, ignore_file, use_ignore_file), ignored_rules)[0]


def _scan(root: Path, patterns, ignored_rules=()) -> tuple[list[Finding], int]:
    """Like scan(), and also return how many requirements are defined."""
    findings, codes, requirements, legacy, _ = _requirements(root, patterns)
    tolerated = None
    for path, number, identifier in _references(root, codes, patterns):
        if identifier in requirements or identifier in legacy:
            continue
        if tolerated is None:
            tolerated = _draft_removals(root, patterns)
        if identifier in tolerated:
            continue
        findings.append(Finding("dangling-ref", path.as_posix(), number, f"引用的编号不存在：{identifier}"))
    findings.extend(_design_gate(root, patterns))

    ignored = set(ignored_rules)
    if ignored:
        findings = [finding for finding in findings if finding.rule not in ignored]
    ordered = sorted(findings, key=lambda item: (item.path, item.line, item.rule, item.message))
    return ordered, len(requirements) + len(legacy)


class _Coverage(NamedTuple):
    requirements: list[str]
    tested: set[str]
    demonstrations: set[str]
    legacy: int


def _coverage(root: Path, patterns) -> _Coverage:
    _, codes, requirements, legacy, demonstrations = _requirements(root, patterns)
    tested = {identifier for path, _, identifier in _references(root, codes, patterns) if _is_test(path)}
    return _Coverage([*sorted(requirements), *sorted(legacy)], tested, demonstrations, len(legacy))


def report(root: Path, ignores=(), ignore_file=None, use_ignore_file: bool = True) -> list[str]:
    """Report test coverage and demonstration IDs without enforcing coverage."""
    root = Path(root)
    return _report_lines(_coverage(root, _ignores(root, ignores, ignore_file, use_ignore_file)))


def _report_lines(coverage: _Coverage) -> list[str]:
    lines: list[str] = []
    for identifier in coverage.requirements:
        if identifier not in coverage.tested and identifier not in coverage.demonstrations:
            lines.append(f"未被测试引用：{identifier}")
        if identifier in coverage.demonstrations:
            lines.append(f"演示要求：{identifier}")
    return lines


def _report_header(coverage: _Coverage) -> str:
    # The three counts partition the total: a tested requirement does not also count as demonstrated.
    ids = coverage.requirements
    tested = sum(identifier in coverage.tested for identifier in ids)
    shown = sum(identifier in coverage.demonstrations and identifier not in coverage.tested
                for identifier in ids)
    neither = len(ids) - tested - shown
    legacy = f"（含 {coverage.legacy} 条旧编号）" if coverage.legacy else ""
    return f"{len(ids)} 条要求{legacy}：{tested} 条有测试引用，{shown} 条靠演示，{neither} 条既没有测试也没有演示"


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Check requirement IDs and references")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true", help="print findings as JSON")
    parser.add_argument("--report", action="store_true", help="report test references and demonstrations")
    parser.add_argument("--ignore", action="append", default=[], metavar="GLOB",
                        help="ignore a relative path glob (repeatable)")
    parser.add_argument("--ignore-rule", action="append", default=[], choices=RULES,
                        help="ignore one rule (repeatable)")
    parser.add_argument("--ignore-file", type=Path, default=None,
                        help=f"read extra globs from this file (default: <root>/{IGNORE_FILE})")
    parser.add_argument("--no-ignore-file", action="store_true",
                        help=f"do not read {IGNORE_FILE}")
    parser.add_argument("--list-rules", action="store_true", help="print each rule and what it checks, then exit")
    parser.add_argument("--version", action="version", version=f"spec_check {VERSION}")
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        return int(error.code)

    if args.list_rules:
        for rule in RULES:
            print(f"{rule:<20}{RULE_HELP[rule]}")
        print(SCOPE)
        return 0
    if not args.root.is_dir():
        return 2
    if args.ignore_file is not None and not args.ignore_file.is_file():
        print(f"--ignore-file 指向的文件不存在：{args.ignore_file}", file=sys.stderr)
        return 2
    patterns = _ignores(args.root, args.ignore, args.ignore_file, not args.no_ignore_file)
    findings, defined = _scan(args.root, patterns, args.ignore_rule)
    if args.json:
        print(json.dumps([asdict(finding) for finding in findings], ensure_ascii=False))
    elif findings:
        for finding in findings:
            print(f"{finding.path}:{finding.line}: [{finding.rule}] {finding.message}")
    else:
        files = sum(1 for _ in _capability_files(args.root, patterns))
        print(f"spec_check：通过（{files} 份能力规格，{defined} 条要求）")
    if args.report:
        coverage = _coverage(args.root, patterns)
        for line in [_report_header(coverage), *_report_lines(coverage)]:
            print(line, file=sys.stderr if args.json else sys.stdout)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
