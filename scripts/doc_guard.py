"""doc_guard v0.4.1

用途：只禁止，不要求；检查文档中的历史过程记录、禁止路径、断链，以及 agent 整份读入的文件有没有超出体积上限。
用法：python doc_guard.py [--root DIR] [--json] [--ignore GLOB]... [--ignore-rule RULE]...
输出：每个问题一行；没有问题时打印一行"通过"和检查了多少份文档。--list-rules 列出每条规则查什么。
退出码：0 无问题；1 有问题；2 根目录不存在或参数错误。
本文件来自 dev-circuit-ultra 仓库，项目里不要修改，升级时整体覆盖。

忽略白名单（误杀时用，不是默认关闭检查）：
  --ignore GLOB           按相对路径忽略，可重复；如 --ignore 'vendor/**'、--ignore CHANGELOG.md
  .dcuignore              项目根目录的忽略清单，一行一个 GLOB，# 开头为注释（与 .gitignore 类似）
  --ignore-rule RULE      忽略某条规则，可重复；--list-rules 查看规则名
  行内抑制                行内写 doc-guard:ignore 只忽略该行；doc-guard:off / doc-guard:on 忽略一段
  --include GLOB          额外把这些 .md 也当文档扫（如 --include notes，默认只扫 docs/specs/design
                          和浅层 README）

代码围栏内的内容不做检查：示例命令和哈希不是文档主张。
"""

import argparse
import fnmatch
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath


VERSION = "0.4.1"
IGNORE_FILE = ".dcuignore"

RULES = (
    "forbidden-path",
    "bookkeeping-phrase",
    "decision-id",
    "long-hash",
    "short-hash",
    "broken-link",
    "oversize",
    "arch-summary",
)

BOOKKEEPING_PHRASES = (
    "轮次记录",
    "决策台账",
    "输入清单",
    "冻结对象",
    "基线提交",
    "固定提交",
    "BUDGET_",
    "SPEC_FROZEN",
    "via anthropic",
    "via openai",
    "via deepseek",
    "已移植",
    "移植日期",
    "原文快照",
    "放弃的备选",
    "已取代",
    "原为",
    "决策记录",
    "decision log",
)

SKIPPED_DIRS = frozenset({
    ".git", "node_modules", "dist", "build", ".venv", "venv",
    "__pycache__", ".pytest_cache",
})
FORBIDDEN_DIRS = frozenset({
    "docs/decisions", "docs/adr", "docs/maintenance", "docs/superpowers",
    "openspec/changes/archive", "ledger", "docs/ledger",
})
FORBIDDEN_SPEC_FILES = frozenset({"plan.md", "tasks.md", "checklist.md", "review.md"})
# Files an agent reads whole stay small enough to read whole.
SPEC_MAX_LINES = 400
CARD_MAX_LINES = 80
SUMMARY_MAX_LINES = 60
ARCHITECTURE = "docs/architecture.md"

DECISION_ID = re.compile(r"\b(?:D-\d{3}|ADR-\d+)\b")
LONG_HASH = re.compile(r"\b[0-9a-f]{32,64}\b")
SHORT_HASH = re.compile(r"(?<![#\w-])[0-9a-f]{7,12}(?![\w-])")
INLINE_LINK = re.compile(r"\[[^\]\n]*\]\(([^)\n]+)\)")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
SUMMARY_ANCHOR = re.compile(r"<a\s+id=[\"']summary[\"']")
HEADING = re.compile(r"^(#{1,6})\s")

# What --list-rules prints, built from the constants above so it cannot drift from them.
RULE_HELP = {
    "forbidden-path": "项目里出现这些目录或文件：" + "、".join(sorted(FORBIDDEN_DIRS))
                      + "、docs/ 或 specs/ 下名为 history 的目录、根目录的 HANDOFF*.md、specs/<功能>/ 下的 "
                      + "、".join(sorted(FORBIDDEN_SPEC_FILES)),
    "bookkeeping-phrase": "文档里出现过程记录短语（按子串匹配）：" + "、".join(BOOKKEEPING_PHRASES),
    "decision-id": "文档里出现决策编号：D- 加三位数字或 ADR- 加数字，如 D-036、ADR-12",
    "long-hash": "文档里出现 32–64 位小写十六进制串",
    "short-hash": "文档里出现 7–12 位、同时含数字和字母的小写十六进制串（像提交号）",
    "broken-link": "Markdown 链接的相对路径指向不存在的文件（不查 http(s)、mailto、# 锚点和绝对路径）",
    "oversize": f"能力规格（docs/requirements/ 下除 README.md 外的 .md）超过 {SPEC_MAX_LINES} 行，"
                f"或卡（specs/<功能>/spec.md）超过 {CARD_MAX_LINES} 行",
    "arch-summary": f"{ARCHITECTURE} 没有用 <a id=\"summary\"></a> 标出的框架摘要，"
                    f"或摘要超过 {SUMMARY_MAX_LINES} 个非空行（到下一个同级标题为止）",
}
SCOPE = ("范围：根目录和 docs/、specs/、design/ 下的 .md，第二、三层目录里的 README.md，以及 --include 指定的 .md；"
         "代码围栏里的内容和 doc-guard:ignore / off 标出的行不查。")

SUPPRESS_LINE = re.compile(r"doc-guard:\s*ignore", re.IGNORECASE)
SUPPRESS_OFF = re.compile(r"doc-guard:\s*off", re.IGNORECASE)
SUPPRESS_ON = re.compile(r"doc-guard:\s*on", re.IGNORECASE)


@dataclass(frozen=True)
class Finding:
    rule: str
    path: str
    line: int
    message: str


def _fold(value: str) -> str:
    """Windows paths are case-insensitive, POSIX paths are not."""
    return value.casefold() if os.name == "nt" else value


def _plain(pattern: str) -> str:
    """Drop a leading "./" or "/"; a dot that starts a name (".github") stays."""
    while pattern.startswith("./"):
        pattern = pattern[2:]
    return pattern.lstrip("/")


def matches(relative: str, patterns) -> bool:
    """Match a posix relative path against path globs (used for ignore and include).

    Patterns accept `/` or `\\` as the separator. A pattern with a separator
    matches from the project root; a pattern without one matches any single
    path segment, so "CHANGELOG.md" also ignores "docs/CHANGELOG.md". Case is
    ignored on Windows and significant elsewhere, matching the filesystem.
    There is no `!` negation: narrow the pattern instead.
    """
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


path_is_ignored = matches  # the previous name, kept for callers

def load_ignore_file(path: Path) -> list[str]:
    """Read one glob per line; blank lines and # comments are skipped."""
    patterns: list[str] = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        entry = line.strip()
        if entry and not entry.startswith("#"):
            patterns.append(entry)
    return patterns


def _is_forbidden_dir(relative: Path) -> bool:
    parts = relative.parts
    return relative.as_posix() in FORBIDDEN_DIRS or (
        len(parts) >= 2 and parts[0] in {"docs", "specs"} and parts[-1] == "history"
    )


def _is_forbidden_file(relative: Path) -> bool:
    parts = relative.parts
    return (
        len(parts) == 1 and fnmatch.fnmatchcase(relative.name, "HANDOFF*.md")
    ) or (
        len(parts) == 3 and parts[0] == "specs" and parts[-1] in FORBIDDEN_SPEC_FILES
    )


def _is_scanned_doc(relative: Path, includes=()) -> bool:
    if includes and relative.suffix == ".md" and matches(relative.as_posix(), includes):
        return True
    parts = relative.parts
    return (
        relative.suffix == ".md" and (
            len(parts) == 1 or (len(parts) >= 2 and parts[0] in {"docs", "specs", "design"})
        )
    ) or (relative.name == "README.md" and len(parts) in {2, 3})


def _walk(root: Path, directory: Path, findings: list[Finding], patterns,
          includes=()) -> list[Path]:
    documents: list[Path] = []
    for path in sorted(directory.iterdir()):
        relative = path.relative_to(root)
        if path.is_dir():
            if path.name in SKIPPED_DIRS:
                continue
            if path_is_ignored(relative.as_posix(), patterns):
                continue
            if _is_forbidden_dir(relative):
                findings.append(Finding("forbidden-path", relative.as_posix(), 0, "禁止的目录"))
                continue
            documents.extend(_walk(root, path, findings, patterns, includes))
        elif path.is_file():
            if path_is_ignored(relative.as_posix(), patterns):
                continue
            if _is_forbidden_file(relative):
                findings.append(Finding("forbidden-path", relative.as_posix(), 0, "禁止的文件"))
            if _is_scanned_doc(relative, includes):
                documents.append(path)
    return documents


def _is_absolute_target(target: str) -> bool:
    return (target.startswith("\\") or PurePosixPath(target).is_absolute()
            or PureWindowsPath(target).is_absolute())


def _scan_links(line: str, document: Path, root: Path, number: int) -> list[Finding]:
    findings: list[Finding] = []
    relative = document.relative_to(root).as_posix()
    for match in INLINE_LINK.finditer(line):
        target = match.group(1)
        if (target.startswith("#") or target.lower().startswith(("http:", "https:", "mailto:"))
                or _is_absolute_target(target)):
            continue
        location = re.split(r"[?#]", target, maxsplit=1)[0]
        if location and not (document.parent / location).exists():
            findings.append(Finding("broken-link", relative, number, f"链接目标不存在：{target}"))
    return findings


def _scan_document(document: Path, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    relative = document.relative_to(root).as_posix()
    fence_char = ""
    fence_length = 0
    suppressed = False
    for number, line in enumerate(document.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        fence = FENCE.match(line)
        if fence:
            marker = fence.group(1)
            if not fence_char:
                fence_char, fence_length = marker[0], len(marker)
            elif (marker[0] == fence_char and len(marker) >= fence_length
                  and not line[fence.end():].strip()):
                fence_char, fence_length = "", 0
            continue
        if fence_char:
            continue

        if SUPPRESS_OFF.search(line):
            suppressed = True
        if SUPPRESS_ON.search(line):
            suppressed = False
        if suppressed or SUPPRESS_LINE.search(line):
            continue

        for match in DECISION_ID.finditer(line):
            findings.append(Finding("decision-id", relative, number, f"决策编号：{match.group()}"))
        for match in LONG_HASH.finditer(line):
            findings.append(Finding("long-hash", relative, number, f"长哈希：{match.group()}"))
        for match in SHORT_HASH.finditer(line):
            value = match.group()
            if any(char.isdigit() for char in value) and any(char.isalpha() for char in value):
                findings.append(Finding("short-hash", relative, number, f"短哈希：{value}"))
        for phrase in BOOKKEEPING_PHRASES:
            if phrase in line:
                findings.append(Finding("bookkeeping-phrase", relative, number, f"过程记录短语：{phrase}"))

        findings.extend(_scan_links(line, document, root, number))
    return findings


def _summary_findings(relative: str, lines: list[str]) -> list[Finding]:
    """The summary runs from its anchor to the next heading of the same or a higher level."""
    anchor = next((index for index, line in enumerate(lines) if SUMMARY_ANCHOR.search(line)), None)
    if anchor is None:
        return [Finding("arch-summary", relative, 1,
                        f'没有框架摘要：在开头用 <a id="summary"></a> 标出，不超过 {SUMMARY_MAX_LINES} 行')]
    level, start = 2, anchor + 1
    heading = HEADING.match(lines[anchor])
    if not heading:
        following = next((index for index in range(anchor + 1, len(lines)) if lines[index].strip()), None)
        if following is not None and (heading := HEADING.match(lines[following])):
            start = following + 1
    if heading:
        level = len(heading.group(1))
    end = next((index for index in range(start, len(lines))
                if (match := HEADING.match(lines[index])) and len(match.group(1)) <= level), len(lines))
    count = sum(1 for line in lines[start:end] if line.strip())
    if count > SUMMARY_MAX_LINES:
        return [Finding("arch-summary", relative, anchor + 1,
                        f"框架摘要 {count} 行，超过 {SUMMARY_MAX_LINES} 行：只留模块、数据归属、契约和约束，细节放正文")]
    return []


def _scan_shape(document: Path, root: Path) -> list[Finding]:
    relative = document.relative_to(root)
    lines = document.read_text(encoding="utf-8", errors="replace").splitlines()
    parts = relative.parts
    if parts[:2] == ("docs", "requirements") and len(parts) == 3 and relative.name != "README.md":
        if len(lines) > SPEC_MAX_LINES:
            return [Finding("oversize", relative.as_posix(), SPEC_MAX_LINES + 1,
                            f"能力规格 {len(lines)} 行，超过 {SPEC_MAX_LINES} 行：按子能力拆成几份")]
    elif len(parts) == 3 and parts[0] == "specs" and relative.name == "spec.md":
        if len(lines) > CARD_MAX_LINES:
            return [Finding("oversize", relative.as_posix(), CARD_MAX_LINES + 1,
                            f"卡 {len(lines)} 行，超过 {CARD_MAX_LINES} 行：把做完的切片收成一行")]
    elif relative.as_posix() == ARCHITECTURE:
        return _summary_findings(relative.as_posix(), lines)
    return []


def scan(root: Path, ignores=(), ignored_rules=(), ignore_file=None,
         use_ignore_file: bool = True, includes=()) -> list[Finding]:
    """Report forbidden paths and content under a project root.

    `ignores` are path globs; `ignored_rules` are rule names from RULES; `includes`
    are extra .md path globs to scan beyond the default scope. When
    `use_ignore_file` is true and a `.dcuignore` exists under `root` (or at
    `ignore_file`), its patterns are added.
    """
    return _scan(root, ignores, ignored_rules, ignore_file, use_ignore_file, includes)[0]


def _scan(root: Path, ignores, ignored_rules, ignore_file, use_ignore_file: bool,
          includes) -> tuple[list[Finding], int]:
    """Like scan(), and also return how many documents were checked."""
    root = Path(root)
    patterns = list(ignores)
    if use_ignore_file:
        candidate = Path(ignore_file) if ignore_file else root / IGNORE_FILE
        if candidate.is_file():
            patterns.extend(load_ignore_file(candidate))

    findings: list[Finding] = []
    documents = _walk(root, root, findings, patterns, includes)
    for document in documents:
        findings.extend(_scan_document(document, root))
        findings.extend(_scan_shape(document, root))

    ignored = set(ignored_rules)
    if ignored:
        findings = [finding for finding in findings if finding.rule not in ignored]
    ordered = sorted(findings, key=lambda item: (item.path, item.line, item.rule, item.message))
    return ordered, len(documents)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Check project documentation for forbidden content")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="project root (default: current directory)")
    parser.add_argument("--json", action="store_true", help="print findings as JSON")
    parser.add_argument("--ignore", action="append", default=[], metavar="GLOB",
                        help="ignore a relative path glob (repeatable)")
    parser.add_argument("--ignore-rule", action="append", default=[], choices=RULES,
                        help="ignore one rule (repeatable)")
    parser.add_argument("--include", action="append", default=[], metavar="GLOB",
                        help="also scan matching .md files outside the default scope (repeatable)")
    parser.add_argument("--ignore-file", type=Path, default=None,
                        help=f"read extra globs from this file (default: <root>/{IGNORE_FILE})")
    parser.add_argument("--no-ignore-file", action="store_true",
                        help=f"do not read {IGNORE_FILE}")
    parser.add_argument("--list-rules", action="store_true", help="print each rule and what it checks, then exit")
    parser.add_argument("--version", action="version", version=f"doc_guard {VERSION}")
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

    findings, documents = _scan(args.root, args.ignore, args.ignore_rule, args.ignore_file,
                                not args.no_ignore_file, args.include)
    if args.json:
        print(json.dumps([asdict(finding) for finding in findings], ensure_ascii=False))
    elif findings:
        for finding in findings:
            print(f"{finding.path}:{finding.line}: [{finding.rule}] {finding.message}")
    else:
        print(f"doc_guard：通过（检查了 {documents} 份文档）")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
