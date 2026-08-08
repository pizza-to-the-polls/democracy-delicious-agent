/**
 * Structured timeline logger for the daemon loop.
 *
 * Writes JSONL records to ~/PizzaAgent/logs/daemon-YYYY-MM-DD.jsonl so
 * each loop iteration and phase transition is auditable.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expandHome } from "./config.js";

export interface TimelineEntry {
  ts: string; // ISO 8601
  event: string;
  phase?: string;
  iteration?: number;
  pr?: number;
  status: "start" | "ok" | "skip" | "fail" | "end";
  detail?: string;
  durationMs?: number;
}

let _logPath: string | null = null;
let _iteration = 0;

async function logPath(config: { paths: { workspace: string } }): Promise<string> {
  if (_logPath) return _logPath;
  const dir = resolve(expandHome(config.paths.workspace), "logs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const today = new Date().toISOString().slice(0, 10);
  _logPath = resolve(dir, `daemon-${today}.jsonl`);
  return _logPath;
}

export async function logTimeline(
  config: { paths: { workspace: string } },
  entry: TimelineEntry,
): Promise<void> {
  const path = await logPath(config);
  const line = JSON.stringify(entry) + "\n";
  await appendFile(path, line, "utf-8");
}

/** Increment and return the current daemon iteration number. */
export function nextIteration(): number {
  _iteration++;
  return _iteration;
}

/** Reset iteration counter (for tests). */
export function resetIteration(): void {
  _iteration = 0;
}