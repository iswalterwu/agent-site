import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build } from "esbuild";

export async function buildPlugin({ root, out, version }) {
  const source = path.join(root, "packages", "dsh-plugin");
  const stage = path.join(out, "dsh-plugin");
  const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error("Desktop and plugin release versions must match");
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, "lib"), { recursive: true });
  const files = JSON.parse(await readFile(path.join(root, "scripts/distribution-files.json"), "utf8"));
  await build({ entryPoints: [path.join(source, "src", "host.ts")], outfile: path.join(stage, "lib", "host.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node22", external: ["@deepseek-ai/*"], logLevel: "warning" });
  await build({ entryPoints: [path.join(source, "src", "client.ts")], outfile: path.join(stage, "lib", "client.js"),
    bundle: true, platform: "browser", format: "cjs", target: "chrome120", external: ["react", "react/*", "@deepseek-ai/*"],
    loader: { ".css": "text", ".png": "dataurl" },
    banner: { js: 'window.__ModuleLoader__.load({id:"dsh-agent-site",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
    footer: { js: "return module.exports;}});" }, logLevel: "warning" });
  const { devDependencies: _dev, ...published } = pkg;
  await writeFile(path.join(stage, "package.json"), JSON.stringify(published, null, 2));
  for (const file of files.pluginFiles.filter(file => file !== "package.json" && !file.startsWith("lib/"))) {
    await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    const input = file === "LICENSE" ? path.join(root, "LICENSE") : path.join(source, file);
    if (file.endsWith(".md")) await writeFile(path.join(stage, file), (await readFile(input, "utf8")).replaceAll("<version>", version));
    else await copyFile(input, path.join(stage, file));
  }
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const result = await promisify(execFile)(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: stage, windowsHide: true });
  const packed = JSON.parse(result.stdout)[0];
  console.log(`Plugin: ${path.join(out, packed.filename)}`);
}
