import { expect, it } from "vitest";
import { commitTitle, deriveActions, REWORK_WINDOW_MS, testWord } from "../../src/core/actions";
import { applyEvents, newSession } from "../../src/core/session";
import { baseName, bubble, firstSentence, lastSentence } from "../../src/core/text";
import type { SiteEvent } from "../../src/core/types";
import { call, meta, result } from "../fixtures/events";
import { min } from "../fixtures/logs";

const acts = (events: SiteEvent[]) => deriveActions(applyEvents(newSession(meta), events));
const sh = (command: string, id = "x", t = min(1)): SiteEvent => call(id, { tool: "bash", op: "shell", command }, t);

it("改代码与拆除的分界：删除行 > 新增行 × 2 才算拆除", () => {
  const edit = (added: number, removed: number) => call("a", { tool: "edit", op: "edit", paths: ["src/api.ts"], added, removed }, min(1));
  expect(acts([edit(12, 3)])[0]).toMatchObject({ kind: "build", text: "改 api.ts +12 −3" });
  expect(acts([edit(3, 6)])[0].kind).toBe("build");
  expect(acts([edit(3, 7)])[0]).toMatchObject({ kind: "demolish", text: "删 api.ts" });
  expect(acts([call("a", { tool: "bash", op: "shell", command: "rm -rf legacy.ts" }, min(1))])[0]).toMatchObject({ kind: "demolish", text: "删 legacy.ts" });
  expect(acts([call("a", { tool: "bash", op: "shell", command: "git revert HEAD" }, min(1))])[0].kind).toBe("demolish");
});
it("测试：进行中、通过、失败带失败数", () => {
  const run = call("t", { tool: "bash", op: "shell", command: "cd /d/r && python -m pytest -q" }, min(1));
  expect(acts([run])[0]).toMatchObject({ kind: "test", text: "pytest …", outcome: "pending" });
  expect(acts([run, result("t", true, min(2))])[0]).toMatchObject({ text: "pytest ✓", outcome: "ok" });
  expect(acts([run, result("t", false, min(2), 3)])[0]).toMatchObject({ text: "pytest ✗ 3", outcome: "fail" });
});
it("返工：同一会话测试失败后 10 分钟内的修改", () => {
  const fail = [call("t", { tool: "bash", op: "shell", command: "npx vitest run" }, min(0)), result("t", false, min(1))];
  const edit = (t: number) => call(`e${t}`, { tool: "edit", op: "edit", paths: ["src/api.ts"], added: 2, removed: 1 }, t);
  expect(acts([...fail, edit(min(9))]).at(-1)).toMatchObject({ kind: "rework", text: "修 api.ts" });
  expect(acts([...fail, edit(min(12))]).at(-1)?.kind).toBe("build");
});
it("提交：标题取自 -m 或 heredoc，取不到写“提交”", () => {
  expect(commitTitle('git commit -m "feat: add x"')).toBe("feat: add x");
  expect(commitTitle("git commit -m \"$(cat <<'EOF'\nfix(core): handle y\n\nbody\nEOF\n)\"")).toBe("fix(core): handle y");
  expect(commitTitle("git commit -F msg.txt")).toBeNull();
  const c = call("c", { tool: "bash", op: "shell", command: 'git commit -m "feat: add x"' }, min(1));
  expect(acts([c, result("c", true, min(1))])[0]).toMatchObject({ kind: "commit", text: "feat: add x", outcome: "ok" });
});
it("读：读工具与读类 shell 命令；其余命令原样显示", () => {
  expect(acts([call("r", { tool: "read", op: "read", paths: ["D:\\r\\specs\\x\\plan.md"] }, min(1))])[0]).toMatchObject({ kind: "read", text: "看 plan.md" });
  expect(acts([call("r", { tool: "bash", op: "shell", command: "cd /d/r && git status" }, min(1))])[0]).toMatchObject({ kind: "read", text: "看 git status" });
  expect(acts([call("o", { tool: "bash", op: "shell", command: "npm install" }, min(1))])[0]).toMatchObject({ kind: "other", text: "npm install" });
});
it("待办、改 tasks.md、派工、模型回退、压缩、限流、思考", () => {
  const got = acts([
    call("d", { tool: "TodoWrite", op: "todo", todos: [{ text: "写测试", status: "in_progress" }] }, min(1)),
    call("w", { tool: "edit", op: "edit", paths: ["specs/x/tasks.md"], added: 1, removed: 1 }, min(2)),
    call("s", { tool: "Agent", op: "spawn", title: "审核 plan" }, min(3)),
    { kind: "model", ts: min(4), model: "claude-opus-5-5", explicit: false },
    { kind: "model", ts: min(5), model: "deepseek-flash", explicit: true },
    { kind: "compaction", ts: min(6) },
    { kind: "api_error", ts: min(7), message: "429", rateLimited: true },
    { kind: "thinking", ts: min(8), text: "先看一下 plan.md 的结构。然后再改。" }]);
  expect(got.map((a) => [a.kind, a.text])).toEqual([["plan", "写测试"], ["plan", "改 tasks.md"], ["spawn", "审核 plan"],
    ["model", "换到 deepseek-flash"], ["compact", "压缩上下文"], ["api_error", "限流，等待中"], ["think", "先看一下 plan.md 的结构。"]]);
});
it("气泡最多 40 字", () => {
  expect(acts([{ kind: "text", ts: min(1), text: "很长".repeat(30) }])[0].text).toHaveLength(40);
});

// ---- 以下是 brief 之外补的用例 ----

it("气泡先脱敏再截断（E1）：截断点落在密钥中间也遮得住；连续空白压成一个空格", () => {
  // 先截断的话只剩 sk-proj-Ab，不够 sk- 规则的 8 个字符，会漏出密钥开头
  const head = "a".repeat(28);
  expect(bubble(`${head} sk-proj-AbC123xyz456DEF789 之后还有`)).toBe(`${head} sk-*** 之后还有`);
  expect(bubble("  看\n\n  plan.md\t 的结构  ")).toBe("看 plan.md 的结构");
  expect(acts([sh("export OPENAI_API_KEY=sk-proj-AbC123xyz456DEF789 && npm install")])[0].text)
    .toBe("export OPENAI_API_KEY=sk-*** && npm ins…");
});
it("句子按句末标点和换行切，不按 . 切；空白段不算句子", () => {
  expect(firstSentence("改好了 api.ts！接着跑测试")).toBe("改好了 api.ts！");
  expect(lastSentence("先看 plan.md。\n然后改 tasks.md；最后提交? ")).toBe("最后提交?");
  expect(lastSentence("全部完成。 \n  ")).toBe("全部完成。");
  expect(firstSentence("")).toBe("");
});
it("baseName：正反斜杠都算分隔符，结尾的分隔符不算一段", () => {
  expect(baseName("D:\\r\\specs/x\\plan.md")).toBe("plan.md");
  expect(baseName("build/")).toBe("build");
  expect(baseName("a.ts")).toBe("a.ts");
});
it("提交标题：PowerShell here-string、-m '…'、<<EOF；以 $( 开头的 -m 跳过；空的给 null", () => {
  expect(commitTitle("git commit -m @'\nfeat(core): x\n\nbody\n'@")).toBe("feat(core): x");
  expect(commitTitle('git commit -m @"\r\n  fix: y  \r\n"@')).toBe("fix: y");
  expect(commitTitle("git commit -m 'docs: z'")).toBe("docs: z");
  expect(commitTitle("git commit -F - <<EOF\nchore: w\nEOF")).toBe("chore: w");
  expect(commitTitle('git commit -m "$(cat msg.txt)"')).toBeNull();
  expect(commitTitle('git commit -m "$(cat msg.txt)" -m "second"')).toBe("second");
  expect(commitTitle('git commit -m "   "')).toBeNull();
  expect(acts([sh("git -C D:/r commit -F msg.txt")])[0]).toMatchObject({ kind: "commit", text: "提交", outcome: "pending" });
});
it("主命令：反复去掉开头的 cd <目录> &&、cd <目录>;、Set-Location <目录>;", () => {
  expect(acts([sh("cd /d/r; cd src && ls -la")])[0]).toMatchObject({ kind: "read", text: "看 ls -la" });
  expect(acts([sh('Set-Location "D:\\my repo"; Get-Content plan.md')])[0]).toMatchObject({ kind: "read", text: "看 Get-Content plan.md" });
  expect(acts([sh("cd /d/r && npm install")])[0]).toMatchObject({ kind: "other", text: "npm install" });
  expect(acts([sh('Set-Location D:\\r; Remove-Item -Recurse "D:\\r\\old dir"')])[0]).toMatchObject({ kind: "demolish", text: "删 old dir" });
});
it("shell 归类顺序：测试 → 提交 → 拆除 → 读 → 其他", () => {
  expect(acts([sh("npx tsc --noEmit", "t"), result("t", false, min(2))])[0]).toMatchObject({ kind: "test", text: "tsc ✗", outcome: "fail" });
  expect(acts([sh("npm run test && git commit -m 'x'")])[0].kind).toBe("test");
  expect(acts([sh("git add -A && git commit -m 'feat: y'")])[0]).toMatchObject({ kind: "commit", text: "feat: y" });
  expect(acts([sh("cd /d/r && git rm src/old.ts")])[0]).toMatchObject({ kind: "demolish", text: "删 old.ts" });
  expect(acts([sh("Get-ChildItem -Recurse src")])[0]).toMatchObject({ kind: "read", text: "看 Get-ChildItem -Recurse src" });
});
it("返工的时间窗：失败结果之后 10 分钟整仍算；调用早于失败不算；拆除和改 tasks.md 不被返工替换", () => {
  const fail = [sh("pytest", "t", min(0)), result("t", false, min(1))];
  const edit = (t: number, path = "src/api.ts", added = 2, removed = 1) =>
    call(`e${t}`, { tool: "edit", op: "edit", paths: [path], added, removed }, t);
  expect(acts([...fail, edit(min(1) + REWORK_WINDOW_MS)]).at(-1)?.kind).toBe("rework");
  expect(acts([...fail, edit(min(1) + REWORK_WINDOW_MS + 1)]).at(-1)?.kind).toBe("build");
  expect(acts([edit(min(0) - 1), ...fail])[0].kind).toBe("build");
  expect(acts([edit(min(2), "specs/x/tasks.md")])[0].kind).toBe("plan");
  expect(acts([edit(min(2), "src/api.ts", 1, 9)])[0].kind).toBe("demolish");
  // 非测试命令失败不算测试失败
  expect(acts([sh("npm install", "i", min(0)), result("i", false, min(1)), edit(min(2))]).at(-1)?.kind).toBe("build");
});
it("各类工具的兜底文字", () => {
  const got = acts([
    call("g", { tool: "Grep", op: "search" }, min(1)),
    call("d1", { tool: "mcp__ccd_turn__update_plan", op: "todo" }, min(2)),
    call("d2", { tool: "todo_write", op: "todo", todos: [{ text: "a", status: "completed" }, { text: "b", status: "pending" }] }, min(3)),
    call("s", { tool: "Agent", op: "spawn" }, min(4)),
    call("q", { tool: "AskUserQuestion", op: "ask", title: "用方案 A 吗？" }, min(5)),
    call("o", { tool: "WebFetch", op: "other" }, min(6)),
    call("w", { tool: "write", op: "write", paths: ["notes.md"] }, min(7)),
    { kind: "api_error", ts: min(8), message: "boom", rateLimited: false },
    { kind: "model", ts: min(9), model: "m1", explicit: false },
    { kind: "model", ts: min(10), model: "m1", explicit: false },
    { kind: "prompt", ts: min(11), text: "继续", from: "user" },
    { kind: "turn_end", ts: min(12) }]);
  expect(got.map((a) => [a.kind, a.text, a.outcome])).toEqual([["read", "看 Grep", "pending"], ["plan", "更新待办", "pending"],
    ["plan", "b", "pending"], ["spawn", "派工", "pending"], ["other", "用方案 A 吗？", "pending"], ["other", "WebFetch", "pending"],
    ["build", "改 notes.md", "pending"], ["api_error", "API 报错", undefined]]);
});

// ---- 修复轮 1：E18–E20 与评审意见 ----

const codeEdit = (t: number) => call(`e${t}`, { tool: "edit", op: "edit", paths: ["src/api.ts"], added: 2, removed: 1 }, t);

it("测试成败（E18）：退出码 0 但有 N failed 也算失败，之后的修改算返工；非测试调用只看 ok", () => {
  const got = acts([sh("npx vitest run | tail -5", "t", min(0)), result("t", true, min(1), 3), codeEdit(min(5))]);
  expect(got[0]).toMatchObject({ kind: "test", text: "vitest ✗ 3", outcome: "fail" });
  expect(got.at(-1)).toMatchObject({ kind: "rework", text: "修 api.ts" });
  expect(acts([sh("pytest", "t"), result("t", false, min(2), 0)])[0]).toMatchObject({ text: "pytest ✗", outcome: "fail" });
  expect(acts([sh("pytest", "t"), result("t", true, min(2), 0)])[0]).toMatchObject({ text: "pytest ✓", outcome: "ok" });
  expect(acts([sh("npm install", "i"), result("i", true, min(2), 2)])[0].outcome).toBe("ok");
});
it("后来通过的测试关掉返工时间窗（E20）；带失败数的“通过”不关", () => {
  const failThenPass = (failed?: number) => [sh("pytest", "t1", min(0)), result("t1", false, min(1)),
    sh("pytest", "t2", min(2)), result("t2", true, min(3), failed), codeEdit(min(4))];
  expect(acts(failThenPass()).at(-1)?.kind).toBe("build");
  expect(acts(failThenPass(1)).at(-1)?.kind).toBe("rework");
});
it("shell 归类只看真正执行的部分（E19）：引号、heredoc、here-string 里的字不算；配置文件名不算测试", () => {
  expect(acts([sh("cat vitest.config.ts")])[0]).toMatchObject({ kind: "read", text: "看 cat vitest.config.ts" });
  expect(acts([sh('rg -n "pytest" docs', "g", min(0)), result("g", false, min(1)), codeEdit(min(2))]).map((a) => a.kind))
    .toEqual(["read", "build"]);
  expect(acts([sh('git commit -m "fix vitest config"')])[0]).toMatchObject({ kind: "commit", text: "fix vitest config" });
  expect(acts([sh("git commit -m \"$(cat <<'EOF'\nfix(ci): pin node\n\nVerified with npx vitest run.\nEOF\n)\"")])[0])
    .toMatchObject({ kind: "commit", text: "fix(ci): pin node" });
  expect(acts([sh('grep -rn "git revert" docs')])[0]).toMatchObject({ kind: "read", text: '看 grep -rn "git revert" docs' });
  expect(acts([sh('npm test && git commit -m "x"')])[0]).toMatchObject({ kind: "test", text: "npm test …" });
  expect(acts([sh("node_modules/.bin/vitest run")])[0]).toMatchObject({ kind: "test", text: "vitest …" });
  expect(acts([sh("cat > notes.md <<'EOF'\nrun pytest, then rm -rf dist\nEOF")])[0].kind).toBe("read");
  expect(acts([sh("$t = @'\nnpx vitest run\n'@\nSet-Content notes.md $t")])[0].kind).toBe("other");
});
it("testWord：命中词或 null（Task 8 判“跑过测试”用它）", () => {
  expect(testWord("cd /d/r && python -m pytest -q")).toBe("pytest");
  expect(testWord("npx tsc --noEmit")).toBe("tsc");
  expect(testWord("cat jest.config.js")).toBeNull();
  expect(testWord("echo 'npm test'")).toBeNull();
});
it("拆除的文件名：删除动词那一段的最后一个参数，跳过开关和重定向", () => {
  expect(acts([sh("rm -f a.ts && git status")])[0]).toMatchObject({ kind: "demolish", text: "删 a.ts" });
  expect(acts([sh("rm -rf dist 2>/dev/null")])[0].text).toBe("删 dist");
  expect(acts([sh("Remove-Item x -Force")])[0].text).toBe("删 x");
  expect(acts([sh("rm -rf build/ > log.txt 2>&1; echo done")])[0].text).toBe("删 build");
});
it("提交标题：-am、--message、-m 值的第一个非空行；只看 git commit 之后的部分", () => {
  expect(commitTitle('git commit -am "fix: a"')).toBe("fix: a");
  expect(commitTitle("git commit --message='fix: b'")).toBe("fix: b");
  expect(commitTitle('git commit --message "fix: c"')).toBe("fix: c");
  expect(commitTitle('git commit -m "\n  feat: d\n\nbody"')).toBe("feat: d");
  expect(commitTitle("cat > notes.md <<'EOF'\nnot the title\nEOF\ngit commit -m \"feat: e\"")).toBe("feat: e");
  expect(commitTitle("echo hi")).toBeNull();
});
it("重复 id：结果归同 id、在它之前最新的那次调用，applyEvents 与 deriveActions 一致", () => {
  const read = (path: string, t: number) => call("x", { tool: "read", op: "read", paths: [path] }, t);
  const s1 = applyEvents(newSession(meta), [read("a.md", min(1)), result("x", true, min(2)), read("b.md", min(3))]);
  expect(s1.calls.map((c) => c.result?.ok)).toEqual([true, undefined]);
  expect(deriveActions(s1).map((a) => a.outcome)).toEqual(["ok", "pending"]);
  const s2 = applyEvents(newSession(meta), [read("a.md", min(1)), read("b.md", min(2)), result("x", false, min(3))]);
  expect(s2.calls.map((c) => c.result?.ok)).toEqual([undefined, false]);
  expect(deriveActions(s2).map((a) => a.outcome)).toEqual(["pending", "fail"]);
});
it("空的思考和文字不出动作", () => {
  expect(acts([{ kind: "thinking", ts: min(1), text: " \n\t " }, { kind: "text", ts: min(2), text: "。" }])).toEqual([]);
});

// ---- 修复轮 2 ----

it("字面量用非空白字符填：引号里的 git -C 路径不挡住提交和拆除；字面量前后的测试词照样认", () => {
  expect(acts([sh('git -C "D:/r" commit -m "feat: x"')])[0]).toMatchObject({ kind: "commit", text: "feat: x" });
  expect(commitTitle('git -C "D:/r" commit -m "feat: x"')).toBe("feat: x");
  expect(acts([sh('git -C "D:/r" rm old.ts')])[0]).toMatchObject({ kind: "demolish", text: "删 old.ts" });
  expect(acts([sh('git -C D:/r commit -m "y"')])[0]).toMatchObject({ kind: "commit", text: "y" });
  expect(testWord("node - <<'EOF' && npx tsc\nconsole.log(1)\nEOF")).toBe("tsc");
});
it("$@ 不是 PowerShell here-string 的开头", () => {
  expect(acts([sh('for f in "$@"\ndo echo $f; done\nnpx vitest run')])[0]).toMatchObject({ kind: "test", text: "vitest …" });
});
it("删除动词后面没有参数时写动词本身", () => {
  expect(acts([sh("rm")])[0].text).toBe("删 rm");
  expect(acts([sh("rm -rf 2>/dev/null")])[0].text).toBe("删 rm");
  expect(acts([sh("git revert --continue")])[0].text).toBe("删 revert");
  expect(acts([sh("cd /d/r &&rm")])[0].text).toBe("删 rm");
});
it("拆除动词：换行也算一段、不分大小写，目标截到行尾", () => {
  expect(acts([sh("echo hi\nrm -rf dist")])[0]).toMatchObject({ kind: "demolish", text: "删 dist" });
  expect(acts([sh("Remove-Item old.ts\necho done")])[0].text).toBe("删 old.ts");
  expect(acts([sh("remove-item old.ts")])[0]).toMatchObject({ kind: "demolish", text: "删 old.ts" });
  expect(acts([sh("DEL old.ts")])[0]).toMatchObject({ kind: "demolish", text: "删 old.ts" });
  expect(acts([sh("rm -rf dist # 清理旧产物")])[0].text).toBe("删 dist");
  expect(acts([sh("rm -rf dist & rm -rf build")])[0].text).toBe("删 dist");
});
it("带值的开关后面那个词不是删除目标", () => {
  expect(acts([sh("Remove-Item x -ErrorAction Stop")])[0].text).toBe("删 x");
  expect(acts([sh("Remove-Item -Recurse -ErrorVariable err x")])[0].text).toBe("删 x");
});
it("# 注释里的命令不算真跑过；@' 前面不是行首或空白就不算 here-string", () => {
  expect(acts([sh("echo hi # npx vitest run")])[0].kind).toBe("other");
  // @ 前面紧挨着别的字符（这里是没有收尾引号的 foo@'）：不当 here-string，正文照看
  expect(acts([sh("foo@'\nnpx vitest run")])[0]).toMatchObject({ kind: "test", text: "vitest …" });
});

it("CONTROL-12：site_todo 的有效调用仍按待办动作显示当前项", () => {
  const todo = { text: "砌墙", status: "in_progress" as const };
  const events: SiteEvent[] = [
    call("t", { tool: "site_todo", op: "todo", todos: [{ text: "读图纸", status: "completed" }, todo] }, min(1)),
    { kind: "tool_result", ts: min(2), id: "t", ok: true, todos: [{ text: "读图纸", status: "completed" }, todo] },
  ];
  expect(acts(events)[0]).toMatchObject({ kind: "plan", text: "砌墙" });
});
