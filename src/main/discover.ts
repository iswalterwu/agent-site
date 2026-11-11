import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { Harness } from "../core/types.js";

export interface Roots { pi: string; claude: string; dsh: string }
export interface Found { harness: Harness; file: string; size: number; mtimeMs: number }

async function entries(dir: string): Promise<Dirent[]> {
  try { return await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function discover(roots: Roots, sinceMs: number): Promise<Found[]> {
  const found: Found[] = [];
  async function add(harness: Harness, file: string): Promise<void> {
    try {
      const stat = await lstat(file);
      if (stat.isFile() && stat.mtimeMs >= sinceMs) found.push({ harness, file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const harness of ["pi", "claude", "dsh"] as const) {
    const root = roots[harness];
    for (const project of await entries(root)) {
      if (!project.isDirectory()) continue;
      const projectPath = path.join(root, project.name);
      for (const item of await entries(projectPath)) {
        const itemPath = path.join(projectPath, item.name);
        if (harness !== "dsh" && item.isFile() && item.name.endsWith(".jsonl")) await add(harness, itemPath);
        if (!item.isDirectory() || harness === "pi") continue;
        if (harness === "dsh") {
          for (const sessionFile of await entries(itemPath)) {
            if (sessionFile.isFile() && sessionFile.name === "session.v4.jsonl.zstd") await add(harness, path.join(itemPath, sessionFile.name));
          }
        } else {
          for (const subdir of await entries(itemPath)) {
            if (!subdir.isDirectory() || subdir.name !== "subagents") continue;
            const subPath = path.join(itemPath, subdir.name);
            for (const agent of await entries(subPath)) {
              if (agent.isFile() && agent.name.startsWith("agent-") && agent.name.endsWith(".jsonl")) await add(harness, path.join(subPath, agent.name));
            }
          }
        }
      }
    }
  }
  return found;
}
