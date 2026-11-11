// 根据已有会话证据推断 feature、楼层与角色，不读文件或访问外部状态。
import { baseName } from "./text";
import type { Attribution, ModelFamily, Pin, Role, SessionState, ToolCall } from "./types";

const DISPATCH = /^#\s+(\S+)\s+(Spec|Clarify|Plan|Checklist|Tasks|Analyze|Implement|Converge|Review|Handoff)(?:\s+R(\d+))?(?=$|[\s：:])/;
const SPEC_PATH = /(?<![\w.-])specs\/([\w.-]+)\/([\w./-]*[\w-])/g;
const GOVERNANCE = /(?:^|[\/\s"'`])(?:docs|workflow|templates)\/|(?:AGENTS|HANDOFF)\.md/i;
const normalize = (s: string): string => s.replace(/\\/g, "/").toLowerCase();

/** 派工抬头只用来认 feature；阶段和轮次保留在返回里，不映射楼层 */
export function parseDispatch(firstPrompt: string, features: readonly string[]):
  { feature: string; stage: string; round?: number; line: string } | null {
  const line = firstPrompt.replace(/^\uFEFF/, "").split(/\r?\n/).find((s) => s.trim() !== "");
  if (line === undefined) return null;
  const match = DISPATCH.exec(line);
  if (match === null || !features.includes(match[1])) return null;
  return { feature: match[1], stage: match[2], ...(match[3] === undefined ? {} : { round: Number(match[3]) }), line };
}

interface Evidence { writes: number; reads: number; last: number }

export function attribute(s: SessionState, features: readonly string[], pin?: Pin): Attribution {
  if (pin && features.includes(pin.feature)) return { rule: "pinned", feature: pin.feature, floor: pin.floor ?? null, detail: "手动钉住" };
  const dispatch = parseDispatch(s.firstPrompt ?? "", features);
  if (dispatch) return { rule: "dispatch", feature: dispatch.feature, floor: null, detail: `派工抬头：${dispatch.line}` };
  const known = new Map(features.map((feature) => [feature.toLowerCase(), feature]));
  const evidence = new Map<string, Evidence>();
  s.calls.forEach(({ call }, index) => {
    for (const [feature, write] of touches(call, known)) {
      const e = evidence.get(feature) ?? { writes: 0, reads: 0, last: index };
      e.last = index;
      if (write) e.writes++; else e.reads++;
      evidence.set(feature, e);
    }
  });
  const winner = [...evidence.entries()].sort((a, b) => (b[1].writes * 3 + b[1].reads) - (a[1].writes * 3 + a[1].reads) || b[1].last - a[1].last)[0];
  if (winner) {
    const [feature, e] = winner;
    return { rule: "specs", feature, floor: null, detail: `specs 文件：${feature} 写 ${e.writes} 次、读 ${e.reads} 次` };
  }
  const branch = s.meta.branch ?? "";
  const directory = baseName(s.meta.cwd);
  const feature = [...features].sort((a, b) => b.length - a.length).find((f) => f.length > 0 && (branch.toLowerCase().includes(f.toLowerCase()) || directory.toLowerCase().includes(f.toLowerCase())));
  if (feature) return { rule: "branch", feature, floor: null, detail: branch.toLowerCase().includes(feature.toLowerCase()) ? `分支 ${branch}` : `目录 ${directory}` };
  const governance = s.calls.filter(({ call }) => [...call.paths, call.command ?? ""].some((s) => GOVERNANCE.test(s.replace(/\\/g, "/")))).length;
  if (s.calls.length > 0 && governance > s.calls.length / 2) return { rule: "governance", detail: `治理类：最近 ${s.calls.length} 次工具调用里 ${governance} 次涉及治理文件` };
  return { rule: "none", detail: "没有归属证据" };
}

export function inferRole(firstPrompt: string | undefined, model: string | undefined, level: number):
  { role: Role; reason: "dispatch" | "model" | "level" } {
  const title = /你是\s*([^：:，,。\n]+)/.exec(firstPrompt ?? "")?.[1] ?? "";
  if (title.includes("审核")) return { role: "inspector", reason: "dispatch" };
  if (title.includes("实施")) return { role: "worker", reason: "dispatch" };
  if (title.includes("协调")) return { role: "foreman", reason: "dispatch" };
  if (/claude-fable/i.test(model ?? "")) return { role: "inspector", reason: "model" };
  if (/gpt-.*-astra|deepseek-flash/i.test(model ?? "")) return { role: "worker", reason: "model" };
  if (/claude-opus/i.test(model ?? "")) return { role: "foreman", reason: "model" };
  return { role: level === 1 ? "foreman" : "worker", reason: "level" };
}

export function modelFamily(model: string | undefined): ModelFamily {
  if (/claude/i.test(model ?? "")) return "claude";
  if (/gpt/i.test(model ?? "")) return "gpt";
  if (/deepseek/i.test(model ?? "")) return "deepseek";
  return "other";
}

/** 同一调用对同一 feature 最多计一次，写入优先于读取；楼层不从这里取。 */
function touches(call: ToolCall, known: Map<string, string>): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const scan = (text: string, write: boolean): void => {
    for (const m of normalize(text).matchAll(SPEC_PATH)) {
      const feature = known.get(m[1]);
      if (feature === undefined) continue;
      if (write || !found.has(feature)) found.set(feature, write);
    }
  };
  for (const path of call.paths) scan(path, call.op === "edit" || call.op === "write");
  if (call.op === "shell" && call.command !== undefined) scan(call.command, false);
  return found;
}
