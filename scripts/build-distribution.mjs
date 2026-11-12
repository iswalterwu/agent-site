import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const root = process.cwd();
const out = path.join(root, "dist", "distribution");
const action = process.argv[2];
const actions = ["desktop", "plugin", "all", "prepare"];
const files = JSON.parse(await readFile(path.join(root, "scripts/distribution-files.json"), "utf8"));

try {
  if (!actions.includes(action) || process.argv.length > 3) throw new Error("Usage: node scripts/build-distribution.mjs desktop | plugin | all | prepare");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version ?? "")) throw new Error("package.json needs a release version");
  await mkdir(out, { recursive: true });
  if (action !== "plugin") await prepareDesktop(pkg.version);
  if (action === "desktop" || action === "all") await packageDesktop(pkg.version);
  if (action === "plugin" || action === "all") {
    const { buildPlugin } = await import("./build-dsh-plugin.mjs");
    await buildPlugin({ root, out, version: pkg.version });
  }
  if (action !== "prepare") await checksums(pkg.version);
} catch (error) {
  console.error(`[agent-site] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function prepareDesktop(version) {
  await import("./build-app.mjs");
  const stage = path.join(out, "app");
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const file of files.appBuildFiles) await copyFile(path.join(root, "dist", "app", file), path.join(stage, file));
  await copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  for (const [source, target] of [["distribution.md", "INSTALL.md"], ["distribution.zh-CN.md", "INSTALL.zh-CN.md"]]) {
    const text = await readFile(path.join(root, "docs", source), "utf8");
    await writeFile(path.join(stage, target), text.replaceAll("<version>", version)
      .replaceAll("(distribution.zh-CN.md)", "(INSTALL.zh-CN.md)").replaceAll("(distribution.md)", "(INSTALL.md)")
      .replaceAll("(../README.md)", "(https://github.com/iswalterwu/agent-site#readme)")
      .replaceAll("(../README.zh-CN.md)", "(https://github.com/iswalterwu/agent-site/blob/main/README.zh-CN.md)"));
  }
  await writeFile(path.join(stage, "THIRD-PARTY-NOTICES.txt"), await thirdPartyNotices());
  await writeFile(path.join(stage, "package.json"), JSON.stringify({ name: "agent-site", version, private: true, main: "main.cjs", license: "MIT",
    description: "Pixel-art desktop monitor for coding-agent sessions.", author: "agent-site contributors" }, null, 2));
  await writeFile(path.join(out, "agent-site.json"), JSON.stringify({ product: "agent-site", version, platform: "win32", arch: "x64", launchProtocol: 1 }, null, 2));
}

async function packageDesktop(version) {
  const { default: builder } = await import("electron-builder");
  const require = createRequire(import.meta.url);
  const electron = require("electron");
  const electronVersion = JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8")).version;
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget("zip", builder.Arch.x64), publish: "never",
    config: {
      appId: "agent-site", productName: "agent-site", electronVersion,
      electronDist: path.dirname(electron), npmRebuild: false, nodeGypRebuild: false,
      directories: { app: path.join(out, "app"), output: path.join(out, "desktop"), buildResources: path.join(root, "src", "app") },
      asar: true,
      files: files.appFiles,
      extraFiles: [{ from: path.join(out, "agent-site.json"), to: "agent-site.json" },
        ...["INSTALL.md", "INSTALL.zh-CN.md", "THIRD-PARTY-NOTICES.txt"].map(file => ({ from: path.join(out, "app", file), to: file })),
        { from: path.join(out, "app", "LICENSE"), to: "LICENSE.agent-site.txt" }],
      afterPack: async context => rm(path.join(context.appOutDir, "resources", "default_app.asar"), { force: true }),
      win: { executableName: "AgentSite", signAndEditExecutable: false, artifactName: `agent-site-${version}-win-x64.zip` },
    },
  });
}

async function checksums(version) {
  const lines = [];
  const artifacts = [path.join(out, `dsh-agent-site-${version}.tgz`), path.join(out, "desktop", `agent-site-${version}-win-x64.zip`)];
  for (const file of artifacts.sort()) {
    const bytes = await readFile(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (bytes) lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(file)}`);
  }
  await writeFile(path.join(out, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function thirdPartyNotices() {
  const notices = ["Bundled JavaScript dependencies. Electron and Chromium licenses are provided separately.\n"];
  for (const name of files.bundledLicenses) {
    const directory = path.join(root, "node_modules", name);
    const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    notices.push(`\n--- ${name} ${pkg.version} (${pkg.license}) ---\n${await readFile(path.join(directory, "LICENSE"), "utf8")}`);
  }
  return notices.join("\n");
}
