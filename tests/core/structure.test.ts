import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const sources = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(path.join(root, dir));
  return out;
};

const imports = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

describe("结构守护", () => {
  it("core 不 import main 或 app：快照层不知道文件系统和窗口", () => {
    for (const file of sources("src/core")) {
      const outer = imports(file).filter((specifier) => specifier.includes("main") || specifier.includes("app"));
      expect({ file: path.relative(root, file), outer }).toEqual({ file: path.relative(root, file), outer: [] });
    }
  });
  it("DIST-3：DSH适配器不反向导入App或引擎，主程序不导入DSH运行时", () => {
    for (const file of sources("packages/dsh-plugin/src")) {
      expect(imports(file).filter(specifier => /src\/(?:app|main)\//.test(specifier))).toEqual([]);
    }
    for (const dir of ["src/app", "src/main", "src/core", "src/protocol"]) {
      for (const file of sources(dir)) expect(imports(file).filter(specifier => specifier.startsWith("@deepseek-ai/"))).toEqual([]);
    }
  });
  it("工地模块只依赖 core 和 node 内置：它同时被引擎和 App 用", () => {
    const specs = imports(path.join(root, "src/core/site.ts"));
    expect(specs.every((specifier) => specifier.startsWith("./"))).toBe(true);
  });
});
