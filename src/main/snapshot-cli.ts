import os from "node:os";
import { SiteEngine } from "./engine";
import { appDataDir, loadSettings } from "./settings";
import { resolveLocale } from "../core/i18n";
import { resolveDshLaunch, rootProblemText, sessionRoots } from "./roots";

const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
const launch = resolveDshLaunch(process.argv.slice(2), process.env, os.homedir());
if (!launch.ok) {
  process.stderr.write(`${rootProblemText(launch.problem, resolveLocale("system", systemLocale))}\n`);
  process.exitCode = 2;
} else await printSnapshot(launch.launch.dshHome);

async function printSnapshot(dshHome: string): Promise<void> {
  const { settings, diagnostics } = loadSettings(appDataDir(process.env), systemLocale);
  const engine = new SiteEngine({ settings: { ...settings, locale: resolveLocale(settings.language, systemLocale) }, diagnostics,
    roots: sessionRoots(os.homedir(), dshHome) });
  await engine.refresh();
  process.stdout.write(`${JSON.stringify(engine.snapshot(), null, 2)}\n`);
  engine.stop();
}
