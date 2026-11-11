// 打包后的单文件桥接（dist/bridge/site-bridge.js）有两组测试：
// 1. 静态检查产物本身：宿主提供的包没被打进去；不写任何文件、除了本机工地的 WebSocket 不联网（规格 5.2 硬性要求 5）。
//    这一组不依赖 pi，任何机器上都跑。
// 2. 冒烟：像用户那样把产物放进 agent 目录的 extensions/，让真实的 pi 命令行自己发现并加载，用 faux 模型在 rpc 和 print
//    两种模式下各跑一轮（print 模式再跑一遍工地中途断开的情形，验证 pi 能自己退出；再跑一遍根本没有 bridge.json 的情形，
//    工地 App 出现之前每个会话都是这样）。机器上没有 pi 就跳过这一组。
//    pi 一律用全新的临时 PI_CODING_AGENT_DIR 和 --no-session 启动，看不到用户的配置、扩展和会话。
// 产物只在 beforeAll 里构建一次，两组测试共用（同一个文件里不会有并发构建把它写到一半）。

import { execFileSync, execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ENV_LEVEL, ENV_PARENT } from "../../src/bridge/lineage";
import { normalizePath } from "../../src/bridge/scope";
import type { BridgeToSite } from "../../src/protocol/v2";
import { startTestSite } from "../harness/site-server";
import type { TestSite } from "../harness/site-server";
import { mkTmpDir, sleep } from "../harness/wait";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BUNDLE = path.join(ROOT, "dist", "bridge", "site-bridge.js");
const FAUX_EXT = path.join(ROOT, "tests", "fixtures", "faux-provider-ext.ts");

let bundle = "";
beforeAll(() => {
  execSync("npm run build:bridge", { cwd: ROOT, stdio: "pipe" });
  bundle = readFileSync(BUNDLE, "utf8");
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------------
// 静态检查：每个函数返回产物里的违规片段，空数组就是干净

/** 宿主（pi）自己提供的包；打进桥接，就会和 pi 自带的那份各有一个实例 */
const HOST_PACKAGE = String.raw`(?:@earendil-works\/pi-[\w-]+|typebox)`;

function bundledHostCode(text: string): string[] {
  // esbuild 给每个打进来的模块写一行 "// 路径"，路径里带包名；createAgentSession 是 pi SDK 的入口函数
  const packages = [...text.matchAll(new RegExp(String.raw`^// .*node_modules\/(${HOST_PACKAGE})\/`, "gm"))].map(([, name]) => name);
  return [...new Set(packages), ...(text.match(/function createAgentSession\b.*/g) ?? [])];
}

// 写文件的 API；每个都有同步（Sync 后缀）、回调、promise（fs.promises、node:fs/promises）三种写法
const FS_WRITERS = ["writeFile", "appendFile", "createWriteStream", "mkdir", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "symlink", "chmod", "truncate"];

function fileWrites(text: string): string[] {
  // 协议模块里有个同名的字符串截断函数 truncate(text, max)，定义和调用都是不带点的裸调用，先抹掉；
  // 文件的 truncate 则只会以具名导入、解构、fs.truncate 或 truncateSync 的样子出现，抹不掉
  const code = text.replace(/(?<![.\w$])truncate\(/g, "(");
  // 不管从哪条路引入（具名导入、解构、fs.xxx、fs.promises.xxx），API 的名字都会以整词出现在产物里
  return code.match(new RegExp(String.raw`\b(?:${FS_WRITERS.join("|")})(?:Sync)?\b`, "g")) ?? [];
}

/**
 * 剪掉打进产物里的 ws 实现。它是完整的 WebSocket 客户端，内部本来就会引用 net / tls / http；
 * 桥接自己那段代码（连同它对 ws 的调用）留在里面，联网检查照样只看这部分
 */
function withoutBundledWs(text: string): string {
  const kept: string[] = [];
  let inWs = false;
  for (const line of text.split("\n")) {
    // esbuild 给每个打进来的模块写一行 "// 路径"
    const marker = /^\/\/ (\S+)$/.exec(line);
    if (marker !== null) inWs = marker[1]!.startsWith("node_modules/ws/");
    if (!inWs) kept.push(line);
  }
  return kept.join("\n");
}

function networking(text: string): string[] {
  const modules = text.match(/["'](?:node:)?(?:https?|http2|net|tls|dgram|dns)(?:\/promises)?["']/g) ?? [];
  const fetches = text.match(/\bfetch\s*\(/g) ?? [];
  // 出现的 ws / http URL 只能是本机工地的 ws://127.0.0.1
  const urls = (text.match(/\b(?:wss?|https?):\/\/[^\s"'`)]*/g) ?? []).filter((url) => !/^ws:\/\/127\.0\.0\.1[:/]/.test(url));
  // 唯一的出口是 new WebSocket(...)（打包后是 new import_websocket.default(...)），
  // 它的参数必须直接就是 ws://127.0.0.1 的字面量，不能是变量
  const sockets = text.match(/new (?:WebSocket|import_websocket\.default)\((?!\s*[`"']ws:\/\/127\.0\.0\.1[:/])[^\n]*/g) ?? [];
  return [...modules, ...fetches, ...urls, ...sockets];
}

describe("打包产物的静态检查（不依赖 pi）", () => {
  it("宿主提供的包既没被打进去，运行时也不引用（参数 schema 是手写的 JSON Schema）", () => {
    expect(bundledHostCode(bundle)).toEqual([]);
    // CONTROL-10：桥接装在全局，宿主哪天不再提供某个模块，所有 pi 会话都起不来，所以产物不 import 任何宿主模块
    expect(bundle.match(/from "@earendil-works\//g) ?? []).toEqual([]);
    expect(bundle).not.toMatch(/from "typebox"/);
  });
  it("产物能被原生 Node 当 ESM 加载，不依赖 pi 的加载器", () => {
    // 装载阶段不碰 ws 的那些 require；真正跑起来时的 CJS 互操作由快照 CLI 的原生冒烟守（tests/main/cli.test.ts，
    // 它也间接带上了 ws）：去掉 banner 就只有那里会红
    const script = `import(${JSON.stringify(pathToFileURL(BUNDLE).href)}).then((m) => {
      if (typeof m.default !== "function") { console.error("default 不是扩展工厂"); process.exit(1); }
      console.log("ok");
    }, (e) => { console.error(e.message); process.exit(1); });`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(out.trim()).toBe("ok");
  });
  it("不写任何文件", () => {
    expect(fileWrites(bundle)).toEqual([]);
  });
  it("除了本机工地的 WebSocket，不联网", () => {
    expect(networking(withoutBundledWs(bundle))).toEqual([]);
  });
  it("产物里除了宿主提供的包，只打进了 ws（为了硬关卡住的连接）", () => {
    const packages = [...new Set([...bundle.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)].map(([, name]) => name))];
    expect(packages).toEqual(["ws"]);
    // 桥接自己那段代码里只有一个地址，就是本机工地
    expect(withoutBundledWs(bundle).match(/`ws:\/\/127\.0\.0\.1/g)).toHaveLength(1);
  });

  // 检查本身要能失败：每一行都是一段违规（或一段不该误伤的）产物代码
  it.each([
    ["具名导入 writeFileSync", fileWrites, 'import { writeFileSync } from "node:fs";', true],
    ["重命名的具名导入 fs/promises", fileWrites, 'import { writeFile as w } from "node:fs/promises";', true],
    ["fs.promises.rm", fileWrites, 'import fs from "node:fs";\nawait fs.promises.rm(file);', true],
    ["fs.createWriteStream", fileWrites, "const out = fs.createWriteStream(file);", true],
    ["解构出 appendFileSync", fileWrites, "const { appendFileSync } = fs;", true],
    ["回调式 fs.mkdir", fileWrites, "fs.mkdir(dir, cb);", true],
    ["fs.truncate", fileWrites, "fs.truncate(file, 0, cb);", true],
    ["具名导入 truncate", fileWrites, 'import { truncate } from "node:fs/promises";', true],
    ["truncateSync", fileWrites, "truncateSync(file, 0);", true],
    ["协议模块自己的字符串截断函数 truncate(text, max)", fileWrites, "function truncate(text, max) {}\nconst s = truncate(summary, 200);", false],
    ["只读的 readFileSync", fileWrites, 'import { readFileSync } from "node:fs";', false],
    ["打进来的 typebox", bundledHostCode, "// node_modules/typebox/build/index.mjs", true],
    ["打进来的 pi SDK", bundledHostCode, "function createAgentSession(options) {}", true],
    ["引用外部的 typebox", bundledHostCode, 'import { Type } from "typebox";', false],
    ["node:http", networking, 'import http from "node:http";', true],
    ["node:net", networking, 'import { connect } from "net";', true],
    ["动态 import node:tls", networking, 'await import("node:tls");', true],
    ["fetch", networking, "await fetch(url);", true],
    ["连别处的 ws", networking, "new WebSocket(`ws://example.com:${port}/bridge`);", true],
    ["连 127.0.0.1.evil.com", networking, 'new WebSocket("ws://127.0.0.1.evil.com/bridge");', true],
    ["参数是变量的 WebSocket", networking, "new WebSocket(target);", true],
    ["https URL", networking, 'const u = "https://example.com/x";', true],
    ["连本机工地的 ws", networking, "new WebSocket(`ws://127.0.0.1:${info.port}/bridge`);", false],
  ] as Array<[string, (text: string) => string[], string, boolean]>)("检查本身有效：%s", (_name, check, code, flagged) => {
    expect(check(code).length > 0).toBe(flagged);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 冒烟：真实的 pi 命令行

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * 在 PATH 里找命令；Windows 上按 PATHEXT 补扩展名（pi 的启动器是 pi.cmd）。
 * 跳过各级 node_modules/.bin：npx / npm 跑测试时会把它们塞到 PATH 最前面，而仓库的开发依赖里也有一份 pi，
 * 不跳过的话冒烟测出来的就是那份，而不是用户机器上实际运行的 pi
 */
function findOnPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter)
    .map((dir) => dir.replace(/^"|"$/g, "").replace(/[\\/]+$/, ""))
    .filter((dir) => dir !== "" && !/[\\/]node_modules[\\/]\.bin$/i.test(dir));
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return undefined;
}

const pi = findOnPath("pi");

/** 每个 pi 子进程都带的参数：不存会话；不加载技能、提示模板、主题和上下文文件（它们会去读用户目录）；用 faux 模型 */
const PI_BASE_ARGS = ["--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", FAUX_EXT, "--model", "faux/faux-1"];

/**
 * pi 子进程的环境：继承当前环境（要用它的 PATH 等），再指向测试工地和全新的 agent 目录，并让 pi 不联网。
 * 跑测试的进程本身可能就在装了桥接的 pi 会话里，所以要去掉层级变量，否则子进程会当成二级 agent
 */
function piEnv(siteDir: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, AGENT_SITE_HOME: siteDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  };
  delete env[ENV_PARENT];
  delete env[ENV_LEVEL];
  return env;
}

/** cmd.exe 里的引用：整个参数放进双引号。参数里不会有 " 和 %（都是路径、模型名和一个词的提示），有就报错，免得被 shell 悄悄改写 */
function quote(arg: string): string {
  if (/["%]/.test(arg)) throw new Error(`参数含有 " 或 %，cmd.exe 里没法安全引用：${arg}`);
  return `"${arg}"`;
}

interface PiRun {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** 进程退出时兑现，值是退出码（启动失败或被信号杀掉时为 null） */
  exited: Promise<number | null>;
}

function startPi(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: "pipe" | "ignore" }): PiRun {
  const common = { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin, "pipe", "pipe"] as ["pipe" | "ignore", "pipe", "pipe"], windowsHide: true };
  // Windows 上 pi 是 pi.cmd，Node 不让直接 spawn .cmd，要经过 shell；命令行自己拼成一整串并给每个参数加引号（给 shell 传参数数组 Node 会警告）
  const child = process.platform === "win32" ? spawn([command, ...args].map(quote).join(" "), { ...common, shell: true }) : spawn(command, args, common);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin?.on("error", () => {}); // pi 先退出了，再写就是 EPIPE；这里不报，由等工地的那一步报出 pi 的输出
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (e) => { stderr += `\n[启动 pi 出错] ${e.message}`; resolve(null); });
    child.once("exit", (code) => resolve(code));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

/** 不拖住进程的计时：测试早早结束时，没到点的计时器不会让测试进程多等 */
const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(resolve, ms, value).unref());

/**
 * 杀掉 pi 的整棵进程树并等它退出（最多 10 秒，等不到就报错，不让残留的进程悄悄溜走）。
 * Windows 上 shell: true 起的是 cmd.exe，child.kill() 只杀得掉它，里面的 node 进程会继续活着，占着临时目录、握着和工地的连接
 */
async function stopPi(run: PiRun): Promise<void> {
  const { child } = run;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // 刚好自己退出了
      }
    } else {
      child.kill();
    }
  }
  if (!(await Promise.race([run.exited.then(() => true), after(10_000, false)]))) throw new Error(`pi（pid ${child.pid}）在 10 秒内没有退出，可能有残留的进程`);
}

type Frame<T extends BridgeToSite["type"]> = Extract<BridgeToSite, { type: T }>;

/**
 * 等工地收到下一个 type 相符且满足 pred 的帧（顺序等待，用的是 site.next 的游标）。
 * pi 在这之前退出、或超时，都报错，并把 pi 的 stdout / stderr 一起带上
 */
async function frame<T extends BridgeToSite["type"]>(site: TestSite, run: PiRun, type: T, pred: (m: Frame<T>) => boolean = () => true, timeoutMs = 30_000): Promise<Frame<T>> {
  const exitedFirst = run.exited.then(async (code) => {
    await sleep(500); // 退出前刚发出的帧可能还在路上，给工地一点时间收下
    throw new Error(`pi 已退出（退出码 ${code}），工地还没等到 ${type}`);
  });
  try {
    return (await Promise.race([site.next((m) => m.type === type && pred(m as Frame<T>), timeoutMs), exitedFirst])) as Frame<T>;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${reason}\n--- pi stdout ---\n${run.stdout()}\n--- pi stderr ---\n${run.stderr()}`, { cause: e });
  }
}

/**
 * 一个仓库、监视它的假工地（writeFile: false 时不写 bridge.json），以及装好桥接的全新 agent 目录 ——
 * 装法和 README 一样：把产物放进 agent 目录的 extensions/，由 pi 自己发现
 */
async function setUp(opts: { writeFile?: boolean } = {}): Promise<{ repo: string; site: TestSite; env: NodeJS.ProcessEnv }> {
  const repo = mkTmpDir();
  const site = await startTestSite({ repos: [repo], writeFile: opts.writeFile });
  const agentDir = mkTmpDir();
  mkdirSync(path.join(agentDir, "extensions"));
  copyFileSync(BUNDLE, path.join(agentDir, "extensions", "site-bridge.js"));
  return { repo, site, env: piEnv(site.dir, agentDir) };
}

/** 工地这一侧该看到的一轮：模型的回复被桥接转成 assistant_text 事件，随后是 agent_idle */
async function expectOneRound(site: TestSite, run: PiRun): Promise<void> {
  await frame(site, run, "event", (m) => m.kind === "agent_idle");
  const said = site.received.find((m) => m.type === "event" && m.kind === "assistant_text");
  expect(said).toMatchObject({ summary: "hello from faux" });
}

/** pi 要在 limitMs 内自己退出（没人杀它），退出码为 0；不然断言失败，并带上 pi 的 stdout / stderr */
async function expectSelfExit(run: PiRun, limitMs = 20_000): Promise<void> {
  const code = await Promise.race([run.exited, after(limitMs, "hung" as const)]);
  expect(code, `pi 没有在 ${limitMs}ms 内自己以 0 退出（${code}）\n--- pi stdout ---\n${run.stdout()}\n--- pi stderr ---\n${run.stderr()}`).toBe(0);
}

/**
 * 跑冒烟测试的主体，不管它成败，随后都杀掉 pi（等它退出）、关掉工地。哪一步出错都不跳过后面的步骤；
 * 几步都出错时一起报，杀 pi 失败不会盖掉测试本身的失败
 */
async function smoke(run: PiRun, site: TestSite, body: () => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of [body, () => stopPi(run), () => site.close()]) {
    try {
      await step();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n--- 接着又出错 ---\n"));
}

/** 不是 JSON 的输出行 */
const nonJsonLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "").filter((line) => {
    try {
      JSON.parse(line);
      return false;
    } catch {
      return true;
    }
  });

/** pi 报告的扩展处理函数错误（对应进程内测试里的 handlerErrors）：rpc 模式是 stdout 里的 extension_error 记录，其他模式打在 stderr 上 */
const extensionErrors = (run: PiRun): string[] => [
  ...run.stdout().split("\n").filter((line) => line.includes('"type":"extension_error"')),
  ...run.stderr().split("\n").filter((line) => line.includes("Extension error")),
];

/**
 * 起一个 print 模式的 pi（二级 agent 就这样跑）。prompt 一启动就开跑，faux 的回复秒回的话，这一轮会在桥接连上工地之前就结束，
 * 所以让 faux 等 release 文件出现才回复，测试等到桥接上线再调用 go() 放行
 */
async function startPrint(): Promise<{ site: TestSite; run: PiRun; go: () => void }> {
  const { repo, site, env } = await setUp();
  const release = path.join(mkTmpDir(), "release");
  const run = startPi(pi as string, [...PI_BASE_ARGS, "-p", "go"], { cwd: repo, env: { ...env, FAUX_HOLD_UNTIL: release }, stdin: "ignore" });
  return { site, run, go: () => writeFileSync(release, "") };
}

describe.skipIf(pi === undefined)("真实 pi 命令行里的冒烟", () => {
  it("rpc 模式：加载打包后的桥接，hello 与一轮事件，关掉 stdin 后告别并自己退出", async () => {
    const { repo, site, env } = await setUp();
    const run = startPi(pi as string, [...PI_BASE_ARGS, "--mode", "rpc"], { cwd: repo, env, stdin: "pipe" });
    await smoke(run, site, async () => {
      const auth = await frame(site, run, "auth");
      expect(auth.session).toMatchObject({ level: 1, mode: "rpc" });
      expect(normalizePath(auth.session.cwd)).toBe(normalizePath(repo));
      await frame(site, run, "state"); // 握手完成、桥接上线后补发的第一个 state
      run.child.stdin?.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "go" })}\n`);
      await expectOneRound(site, run);
      run.child.stdin?.end(); // rpc 的正常收尾：关掉 stdin，pi 释放运行时后退出
      expect((await frame(site, run, "bye")).reason).toBe("shutdown");
      await expectSelfExit(run);
      // rpc 的 stdout 只有协议记录：非交互模式下 pi 把别人写进 stdout 的东西都改道到 stderr（main.js 里的 takeOverStdout）。
      // 所以桥接要是往控制台写了什么，会出现在 stderr 上，由 stderr 为空这一条抓住
      expect(nonJsonLines(run.stdout())).toEqual([]);
      expect(extensionErrors(run)).toEqual([]);
      expect(run.stderr()).toBe("");
      expect(site.invalid).toEqual([]);
    });
  }, 90_000);

  it("print 模式（二级 agent 的跑法）：跑完一轮自己退出，不用谁来杀", async () => {
    const { site, run, go } = await startPrint();
    await smoke(run, site, async () => {
      const auth = await frame(site, run, "auth");
      expect(auth.session).toMatchObject({ level: 1, mode: "print" });
      await frame(site, run, "state");
      go();
      await expectOneRound(site, run);
      expect((await frame(site, run, "bye")).reason).toBe("shutdown");
      await expectSelfExit(run);
      expect(run.stdout()).toContain("hello from faux");
      expect(extensionErrors(run)).toEqual([]);
      expect(run.stderr()).toBe("");
      expect(site.invalid).toEqual([]);
    });
  }, 90_000);

  it("print 模式里工地中途断开：60 秒放行宽限计时不拖住退出，pi 照样自己退出", async () => {
    const { site, run, go } = await startPrint();
    await smoke(run, site, async () => {
      await frame(site, run, "hello");
      await frame(site, run, "state");
      site.drop(); // 桥接掉线，开始放行宽限计时。这个计时器没有 unref，会话收尾（session_shutdown）时必须清掉它，否则 pi 要等到点才退得出去
      await sleep(300); // 给桥接一点时间发现连接断了
      go();
      await expectSelfExit(run);
      expect(run.stdout()).toContain("hello from faux");
      expect(extensionErrors(run)).toEqual([]);
      expect(run.stderr()).toBe("");
    });
  }, 90_000);

  it("print 模式、没有 bridge.json（工地 App 出现之前每个会话都这样）：pi 自己退出，stdout 只有回答，stderr 为空，工地没见过连接", async () => {
    const { repo, site, env } = await setUp({ writeFile: false });
    const run = startPi(pi as string, [...PI_BASE_ARGS, "-p", "go"], { cwd: repo, env, stdin: "ignore" });
    await smoke(run, site, async () => {
      await expectSelfExit(run);
      expect(run.stdout()).toBe("hello from faux\n");
      expect(run.stderr()).toBe("");
      expect(site.accepted()).toBe(0);
    });
  }, 90_000);
});
