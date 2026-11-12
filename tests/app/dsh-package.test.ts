import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";

it("DIST-10：商店条目只指向自身子包、像素图标与版本固定的预构建Release", () => {
  const source = path.resolve(__dirname, "../../packages/dsh-plugin");
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  const entry = fs.readFileSync(path.join(source, "marketplace.yml"), "utf8").replaceAll("\r\n", "\n");
  expect(entry).toContain("url: https://github.com/iswalterwu/agent-site/tree/main/packages/dsh-plugin\n");
  expect(entry).toContain(`tarball: https://github.com/iswalterwu/agent-site/releases/download/v${pkg.version}/dsh-agent-site-${pkg.version}.tgz\n`);
  expect(entry).toContain("assets/logo-192.png");
  expect(entry).toContain("read-only");
  expect(entry).not.toContain("latest/download");
});

it("DIST-11、DIST-12：真实tgz包含所有离线媒体入口，浏览器图片内联且样式限定插件", () => {
  const root = path.resolve(__dirname, "../..");
  execFileSync(process.execPath, ["scripts/build-distribution.mjs", "plugin"], { cwd: root, timeout: 20000 });
  const tar = gunzipSync(fs.readFileSync(path.join(root, "dist/distribution/dsh-agent-site-0.1.0.tgz")));
  const files = new Map<string, Buffer>();
  // npm pack 的标准 ustar 头；只读取自己生成的普通文件，不解压或执行内容。
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/, "");
    if (name === "") break;
    const size = parseInt(tar.toString("ascii", at + 124, at + 136).replace(/\0.*$/, "").trim(), 8) || 0;
    const kind = tar.toString("ascii", at + 156, at + 157);
    if (kind === "0" || kind === "\0") files.set(name.replace(/^package\//, ""), tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const pkg = JSON.parse(files.get("package.json")!.toString());
  expect(pkg.icon).toBe("assets/logo-192.png");
  expect(pkg.exports["./icon"]).toBe("./assets/logo-192.png");
  for (const file of [pkg.icon, "assets/logo-48.png", "assets/logo-96.png", "assets/scene-1x.png", "assets/scene-2x.png", "locale/detail.en.md", "locale/detail.zh.md", "screenshots.json"]) expect(files.has(file), file).toBe(true);
  for (const screenshot of JSON.parse(files.get("screenshots.json")!.toString())) {
    expect(screenshot).not.toMatch(/https?:|\.\./);
    expect(files.has(screenshot)).toBe(true);
  }
  const client = files.get("lib/client.js")!.toString();
  expect(client).toContain("data:image/png;base64,");
  expect(client).toContain("data-agent-site-panel");
  expect(client).toContain("--as-component-highlight");
  expect(client).not.toContain("http://");
  expect(pkg.scripts).toBeUndefined();
  expect(pkg.devDependencies).toBeUndefined();
  expect(files.get("README.md")!.toString()).toContain(`dsh-agent-site-${pkg.version}.tgz`);
  expect(files.get("README.zh-CN.md")!.toString()).not.toContain("<version>");
});
