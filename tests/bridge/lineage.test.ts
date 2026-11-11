import { expect, it } from "vitest";
import { ENV_LEVEL, ENV_PARENT, exportLineage, readLineage } from "../../src/bridge/lineage";

type Env = Record<string, string | undefined>;

it("层级：顶层为 1，子进程继承父会话并加一", () => {
  expect(readLineage({})).toEqual({ level: 1 });
  const env: Record<string, string | undefined> = {};
  exportLineage(env, "s1", 1);
  expect(readLineage(env)).toEqual({ parentId: "s1", level: 2 });
  expect(readLineage({ [ENV_PARENT]: "p", [ENV_LEVEL]: "garbage" })).toEqual({ parentId: "p", level: 2 });
});

// 以下是补充的测试：变量名与取值、逐级继承、没有父会话时的忽略规则、非法层级的边界。
it("导出的是约定的两个变量：本会话的 ID 和层级（十进制字符串），其他变量原样保留", () => {
  const env: Env = { PATH: "keep" };
  exportLineage(env, "s1", 3);
  expect(env).toEqual({ PATH: "keep", AGENT_SITE_PARENT_SESSION: "s1", AGENT_SITE_LEVEL: "3" });
  expect(ENV_PARENT).toBe("AGENT_SITE_PARENT_SESSION");
  expect(ENV_LEVEL).toBe("AGENT_SITE_LEVEL");
});
it("逐级继承：二级会话导出自己的 ID 后，它的子进程读到的是二级的下一级", () => {
  const env: Env = {};
  exportLineage(env, "top", readLineage(env).level); // 一级会话启动
  const second = readLineage(env); // 它的子进程：二级
  expect(second).toEqual({ parentId: "top", level: 2 });
  exportLineage(env, "mid", second.level); // 二级会话启动，覆盖上一层写下的值
  expect(readLineage(env)).toEqual({ parentId: "mid", level: 3 });
});
it("合法的层级变量（正整数的十进制写法）加一", () => {
  for (const [raw, level] of [["1", 2], ["2", 3], ["10", 11]] as const) {
    expect(readLineage({ [ENV_PARENT]: "p", [ENV_LEVEL]: raw })).toEqual({ parentId: "p", level });
  }
});
it("层级变量不是正整数的十进制写法（空串、0、负数、小数、带空白或尾字符、科学计数、十六进制、超出安全整数）一律按二级处理", () => {
  for (const raw of ["", "0", "-1", "1.5", " 2", "2 ", "3abc", "1e3", "0x10", "99999999999999999999"]) {
    expect(readLineage({ [ENV_PARENT]: "p", [ENV_LEVEL]: raw }), `ENV_LEVEL=${JSON.stringify(raw)}`).toEqual({ parentId: "p", level: 2 });
  }
  expect(readLineage({ [ENV_PARENT]: "p" })).toEqual({ parentId: "p", level: 2 }); // 没设层级变量
});
it("没有父会话（缺席或空串）时不看层级变量，仍是一级", () => {
  expect(readLineage({ [ENV_LEVEL]: "5" })).toEqual({ level: 1 });
  expect(readLineage({ [ENV_PARENT]: "", [ENV_LEVEL]: "5" })).toEqual({ level: 1 });
  expect(readLineage({ [ENV_PARENT]: undefined, [ENV_LEVEL]: "5" })).toEqual({ level: 1 });
});
