/**
 * Clean up orphaned worktrees, stale state files, and session transcripts.
 *
 * Called with --all to remove everything, or with --dry-run to preview.
 * By default only removes worktrees whose git metadata has been pruned.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import type { AgentConfig } from "../config.js";
import { expandHome } from "../config.js";
import { processAlive } from "./run.js";

export interface CleanResult {
  worktreesRemoved: number;
  stateFilesRemoved: number;
  sessionDirsRemoved: number;
  locksRemoved: number;
  bytesFreed: number;
  errors: string[];
}

async function dirSize(dirPath: string): Promise<number> {
  let size = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await dirSize(full);
      } else {
        try { size += statSync(full).size; } catch { /* skip */ }
      }
    }
  } catch { /* dir may not exist */ }
  return size;
}

export async function runClean(config: AgentConfig, options: {
  dryRun: boolean;
  all: boolean;
}): Promise<number> {
  const root = expandHome(config.paths.workspace);
  const result: CleanResult = { worktreesRemoved: 0, stateFilesRemoved: 0, sessionDirsRemoved: 0, locksRemoved: 0, bytesFreed: 0, errors: [] };

  const worktreesDir = resolve(root, "worktrees");
  const stateDir = resolve(root, "state");
  const sessionsDir = resolve(root, "sessions");

  // ---- 1. Clean worktrees ---------------------------------------------------
  try {
    const repos = await readdir(worktreesDir, { withFileTypes: true });
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      const repoPath = resolve(worktreesDir, repo.name);
      const issues = await readdir(repoPath, { withFileTypes: true });
      for (const issue of issues) {
        if (!issue.isDirectory()) continue;
        const worktreePath = resolve(repoPath, issue.name);
        let shouldRemove = options.all;

        if (!shouldRemove) {
          // Check if git metadata is intact.
          try {
            const gitFile = await readFile(resolve(worktreePath, ".git"), "utf8");
            const gitDir = gitFile.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
            if (gitDir) {
              try { statSync(gitDir); } catch { shouldRemove = true; }
            } else {
              shouldRemove = true;
            }
          } catch {
            // .git file missing — definitely orphaned.
            shouldRemove = true;
          }
        }

        if (shouldRemove) {
          const sz = await dirSize(worktreePath);
          if (options.dryRun) {
            console.log(`  [dry-run] would remove worktree: ${worktreePath} (${(sz / 1e6).toFixed(1)} MB)`);
          } else {
            await rm(worktreePath, { recursive: true, force: true });
            console.log(`  removed worktree: ${worktreePath} (${(sz / 1e6).toFixed(1)} MB)`);
          }
          result.worktreesRemoved++;
          result.bytesFreed += sz;
        }
      }
    }
  } catch (err) {
    result.errors.push(`worktrees: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- 2. Clean state files -------------------------------------------------
  if (options.all) {
    try {
      const entries = await readdir(stateDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) {
          const statePath = resolve(stateDir, entry.name);
          const sz = statSync(statePath).size;
          if (options.dryRun) {
            console.log(`  [dry-run] would remove state: ${statePath}`);
          } else {
            await rm(statePath, { force: true });
          }
          result.stateFilesRemoved++;
          result.bytesFreed += sz;
        }
        // Also clean subdirectories (like pizza-to-the-polls--pizzabase/)
        if (entry.isDirectory()) {
          const subPath = resolve(stateDir, entry.name);
          const subEntries = await readdir(subPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && (sub.name.endsWith(".json") || sub.name.endsWith(".md"))) {
              const filePath = resolve(subPath, sub.name);
              const sz = statSync(filePath).size;
              if (options.dryRun) {
                console.log(`  [dry-run] would remove state: ${filePath}`);
              } else {
                await rm(filePath, { force: true });
              }
              result.stateFilesRemoved++;
              result.bytesFreed += sz;
            }
          }
        }
      }
    } catch (err) {
      result.errors.push(`state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 3. Clean sessions ----------------------------------------------------
  if (options.all) {
    try {
      const dirs = await readdir(sessionsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          const sessionPath = resolve(sessionsDir, dir.name);
          const sz = await dirSize(sessionPath);
          if (options.dryRun) {
            console.log(`  [dry-run] would remove session: ${sessionPath}`);
          } else {
            await rm(sessionPath, { recursive: true, force: true });
          }
          result.sessionDirsRemoved++;
          result.bytesFreed += sz;
        }
      }
    } catch (err) {
      result.errors.push(`sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 4. Clean stale locks (holder process no longer alive) -----------------
  try {
    const lockEntries = await readdir(resolve(root, "locks"), { withFileTypes: true });
    for (const entry of lockEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
      const lockFilePath = resolve(root, "locks", entry.name);
      let stale = false;
      try {
        const content = await readFile(lockFilePath, "utf8");
        const pid = Number.parseInt(content.split("\n")[0] ?? "", 10);
        stale = Number.isFinite(pid) && pid !== process.pid && !processAlive(pid);
      } catch {
        stale = true; // unreadable lock — treat as stale
      }
      if (!stale && !options.all) continue;
      if (options.dryRun) {
        console.log(`  [dry-run] would remove lock: ${lockFilePath}`);
      } else {
        await rm(lockFilePath, { force: true });
        console.log(`  removed lock: ${lockFilePath}`);
      }
      result.locksRemoved++;
    }
  } catch {
    // locks dir may not exist
  }

  console.log(
    `\nClean complete: ${result.worktreesRemoved} worktree(s), ${result.stateFilesRemoved} state file(s), ${result.sessionDirsRemoved} session dir(s), ${result.locksRemoved} lock(s) removed (${(result.bytesFreed / 1e6).toFixed(1)} MB freed)${options.dryRun ? " [dry-run]" : ""}`,
  );
  for (const error of result.errors) console.error(`  error: ${error}`);
  return result.errors.length > 0 ? 1 : 0;
}