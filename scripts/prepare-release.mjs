import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
try {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check-source")) throw new Error("Usage: node scripts/prepare-release.mjs [--check-source]");
  const commit = releaseSource();
  if (process.argv[2] === "--check-source") console.log(`Public source verified: ${commit}`);
  else {
    execFileSync(process.execPath, ["scripts/build-distribution.mjs", "all"], { cwd: root, stdio: "inherit" });
    execFileSync("python", ["scripts/check_distribution.py"], { cwd: root, stdio: "inherit" });
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const out = path.join(root, "dist", "release", version);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (const file of [`desktop/agent-site-${version}-win-x64.zip`, `dsh-agent-site-${version}.tgz`, "SHA256SUMS"]) {
      await copyFile(path.join(root, "dist", "distribution", file), path.join(out, path.basename(file)));
    }
    console.log(`Prepared ${version} from public commit ${commit}. Only ZIP, TGZ and SHA256SUMS were collected. Nothing was uploaded.`);
  }
} catch (error) {
  console.error(`[agent-site] ${error instanceof Error ? error.message : "Release preparation failed"}`);
  console.error("No upload was attempted. Correct the reported source/build/check problem and run preparation again.");
  process.exitCode = 1;
}

function releaseSource() {
  const git = (...args) => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { throw new Error("Use a clean checkout of the reviewed public repository with origin/main available."); }
  };
  const origin = git("remote", "get-url", "origin");
  if (!["https://github.com/iswalterwu/agent-site.git", "https://github.com/iswalterwu/agent-site", "git@github.com:iswalterwu/agent-site.git"].includes(origin)) {
    throw new Error("Release source must be the reviewed public agent-site repository, not the development repository.");
  }
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Release source must be clean, including untracked files.");
  const commit = git("rev-parse", "HEAD");
  if (commit !== git("rev-parse", "refs/remotes/origin/main")) throw new Error("Release source must match the synchronized public origin/main commit.");
  return commit;
}
