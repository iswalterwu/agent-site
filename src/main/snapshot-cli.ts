import os from "node:os";
import path from "node:path";
import { SiteEngine } from "./engine";
import { appDataDir, loadSettings } from "./settings";

const { settings, diagnostics } = loadSettings(appDataDir(process.env));
const home = os.homedir();
const engine = new SiteEngine({ settings, diagnostics, roots: {
  pi: path.join(home, ".pi", "agent", "sessions"), claude: path.join(home, ".claude", "projects"), dsh: path.join(home, ".dsh", "sessions"),
} });
await engine.refresh();
process.stdout.write(`${JSON.stringify(engine.snapshot(), null, 2)}\n`);
engine.stop();
