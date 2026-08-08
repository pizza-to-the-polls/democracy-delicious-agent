/**
 * Continuous daemon mode.
 *
 * Loops forever: discovers agent:ready issues → works them → reviews
 * open agent PRs → merges accepted ones → repeats. File-based locking
 * in runAuto prevents multiple daemon instances from colliding.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentConfig } from "../config.js";
import { expandHome } from "../config.js";
import { runAuto } from "./run.js";
import { runReview } from "./review.js";

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  /** Poll interval in seconds when no work is found (default: 60). */
  pollIntervalSeconds: number;
  /** Run a single iteration and exit. */
  once: boolean;
  /** Plan only — pass through to work + review. */
  dryRun: boolean;
  /** Restrict work to a single repository. */
  repo?: string;
}

export async function runDaemon(config: AgentConfig, options: DaemonOptions): Promise<number> {
  // Ensure the locks directory exists.
  const lockDir = resolve(expandHome(config.paths.workspace), "locks");
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  let shutdown = false;

  const onShutdown = () => {
    if (!shutdown) {
      shutdown = true;
      console.log("\nShutting down gracefully (finishing current task)...");
    }
  };
  process.on("SIGTERM", onShutdown);
  process.on("SIGINT", onShutdown);

  console.log(`Daemon started (pid ${process.pid}). Polling every ${options.pollIntervalSeconds}s.`);
  if (options.dryRun) console.log("DRY RUN — no repository changes will be made.");
  console.log("Press Ctrl+C to stop.\n");

  let iteration = 0;

  while (!shutdown) {
    iteration++;
    const label = options.once ? `[once #${iteration}]` : `[loop #${iteration}]`;
    console.log(`${label} Scanning for work...`);

    // ---- 1. Discover and work an issue ------------------------------------
    let didWork = false;
    try {
      const workResult = await runAuto(config, {
        repo: options.repo,
        dryRun: options.dryRun,
      });
      if (workResult !== 0) didWork = true;
    } catch (error) {
      console.error(`${label} Work error:`, error instanceof Error ? error.message : String(error));
    }

    // ---- 2. Review and merge open agent PRs --------------------------------
    try {
      const reviewResult = await runReview(config, {
        dryRun: options.dryRun,
        repo: options.repo,
      });
      if (reviewResult !== 0) didWork = true;
    } catch (error) {
      console.error(`${label} Review error:`, error instanceof Error ? error.message : String(error));
    }

    if (options.once || shutdown) break;

    // If we did work, check immediately for more. Otherwise, sleep.
    if (!didWork) {
      console.log(`${label} Nothing to do. Sleeping ${options.pollIntervalSeconds}s...\n`);
      await sleep(options.pollIntervalSeconds * 1000);
    } else {
      console.log(`${label} Work done, checking for more immediately...\n`);
    }
  }

  console.log("Daemon stopped.");
  return 0;
}