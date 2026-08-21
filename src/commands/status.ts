/**
 * Status command — read-only summary of local agent state.
 *
 * Shows held locks (with PID liveness), saved work state, worktrees,
 * sessions, today's timeline tail, and current OpenRouter usage.
 * Never talks to GitHub or spends model budget.
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentConfig } from "../config.js";
import { expandHome } from "../config.js";
import { getOpenRouterUsage } from "../budget.js";

interface LockInfo {
  name: string;
  pid: number | null;
  ageMinutes: number;
  processAlive: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function listLocks(root: string): Promise<LockInfo[]> {
  const locks: LockInfo[] = [];
  let entries;
  try {
    entries = await readdir(resolve(root, "locks"), { withFileTypes: true });
  } catch {
    return locks;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".lock")) continue;
    const content = await readFile(resolve(root, "locks", entry.name), "utf8").catch(() => "");
    const [pidLine, tsLine] = content.split("\n");
    const pid = Number.parseInt(pidLine ?? "", 10);
    const created = Date.parse(tsLine ?? "");
    locks.push({
      name: entry.name.replace(/\.lock$/, ""),
      pid: Number.isFinite(pid) ? pid : null,
      ageMinutes: Number.isFinite(created) ? Math.round((Date.now() - created) / 60_000) : NaN,
      processAlive: Number.isFinite(pid) ? pidAlive(pid) : false,
    });
  }
  return locks;
}

async function listStates(root: string): Promise<Array<{ file: string; phase: string; updatedAt: string; costUsd: number }>> {
  const states: Array<{ file: string; phase: string; updatedAt: string; costUsd: number }> = [];
  let repos;
  try {
    repos = await readdir(resolve(root, "state"), { withFileTypes: true });
  } catch {
    return states;
  }
  for (const entry of repos) {
    const files = entry.isDirectory()
      ? (await readdir(resolve(root, "state", entry.name), { withFileTypes: true }))
          .filter((f) => f.isFile() && f.name.endsWith(".json"))
          .map((f) => `${entry.name}/${f.name}`)
      : entry.isFile() && entry.name.endsWith(".json")
        ? [entry.name]
        : [];
    for (const file of files) {
      try {
        const raw = JSON.parse(await readFile(resolve(root, "state", file), "utf8")) as {
          phase?: string;
          updatedAt?: string;
          costs?: Record<string, number>;
        };
        states.push({
          file: file.replace(/\.json$/, "").replaceAll("/", "#"),
          phase: raw.phase ?? "?",
          updatedAt: raw.updatedAt ?? "?",
          costUsd: Object.values(raw.costs ?? {}).reduce((sum, v) => sum + v, 0),
        });
      } catch { /* skip unreadable */ }
    }
  }
  return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function listSubdirs(root: string, name: string): Promise<string[]> {
  try {
    const entries = await readdir(resolve(root, name), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function timelineTail(root: string, count: number): Promise<string[]> {
  try {
    const dir = resolve(root, "logs");
    const files = (await readdir(dir)).filter((f) => f.startsWith("daemon-") && f.endsWith(".jsonl")).sort();
    if (files.length === 0) return [];
    const lines = (await readFile(resolve(dir, files[files.length - 1]), "utf8")).trim().split("\n");
    return lines.slice(-count);
  } catch {
    return [];
  }
}

export async function runStatus(config: AgentConfig): Promise<number> {
  const root = expandHome(config.paths.workspace);

  console.log("── Locks ──────────────────────────────────────────");
  const locks = await listLocks(root);
  if (locks.length === 0) console.log("  none held");
  for (const lock of locks) {
    const stale = lock.pid !== null && !lock.processAlive;
    console.log(
      `  ${lock.name}  pid=${lock.pid ?? "?"} ${lock.processAlive ? "alive" : "DEAD"}${Number.isNaN(lock.ageMinutes) ? "" : `, ${lock.ageMinutes}m old`}${stale ? "  ← stale (takeover on next run)" : ""}`,
    );
  }

  console.log("\n── Work state ─────────────────────────────────────");
  const states = await listStates(root);
  if (states.length === 0) console.log("  no saved state");
  for (const s of states) {
    console.log(`  ${s.file}  phase=${s.phase}  spent=$${s.costUsd.toFixed(4)}  updated=${s.updatedAt}`);
  }

  console.log("\n── Worktrees ──────────────────────────────────────");
  const worktrees = await listSubdirs(root, "worktrees");
  if (worktrees.length === 0) console.log("  none");
  for (const w of worktrees) console.log(`  ${w}`);

  console.log("\n── Sessions ───────────────────────────────────────");
  const sessions = await listSubdirs(root, "sessions");
  console.log(sessions.length === 0 ? "  none" : `  ${sessions.length} session dir(s)`);

  console.log("\n── Timeline (latest events) ───────────────────────");
  const tail = await timelineTail(root, 8);
  if (tail.length === 0) console.log("  no timeline records");
  for (const line of tail) console.log(`  ${line}`);

  console.log("\n── OpenRouter usage ───────────────────────────────");
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("  OPENROUTER_API_KEY not loaded — skipping");
  } else {
    try {
      const usage = await getOpenRouterUsage();
      console.log(`  today $${usage.usageDaily.toFixed(2)} / limit $${config.budget.dailyUsd.toFixed(2)}; total $${usage.usage.toFixed(2)}${usage.remaining !== null ? `; remaining $${usage.remaining.toFixed(2)}` : ""}`);
    } catch (err) {
      console.log(`  unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return 0;
}
