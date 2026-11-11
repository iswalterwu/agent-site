import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const out = path.join(process.cwd(), "dist", "app");
mkdirSync(out, { recursive: true });

const common = { bundle: true, logLevel: "warning", sourcemap: false };
await build({ ...common, entryPoints: ["src/app/main.ts"], outfile: path.join(out, "main.cjs"),
  platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ ...common, entryPoints: ["src/app/preload.ts"], outfile: path.join(out, "preload.cjs"),
  platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ ...common, entryPoints: ["src/app/renderer.ts"], outfile: path.join(out, "renderer.js"),
  platform: "browser", format: "iife", target: "chrome120",
  define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false" } });
copyFileSync("src/app/index.html", path.join(out, "index.html"));
copyFileSync("src/app/icon.png", path.join(out, "icon.png"));
copyFileSync("src/app/icon-waiting.png", path.join(out, "icon-waiting.png"));
