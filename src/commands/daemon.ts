/**
 * Daemon mode — continuous autonomous loop.
 *
 * Each iteration: respond to feedback → review open PRs → discover + work
 * the next agent:ready issue. Runs indefinitely unless --once is given.
 * Structured timeline records are written for every phase transition.
 */

import type { AgentConfig } from "../config.js";
import { logTimeline, nextIteration } from "../timeline.js";
import { runRespond } from "./respond.js";
import { runReview } from "./review.js";
import { runAuto } from "./run.js";

export interface DaemonOptions {
  once: boolean;
  dryRun: boolean;
  pollSeconds: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one pipeline phase, logging success/failure to the timeline. */
async function runPhase(
  config: AgentConfig,
  phase: string,
  iteration: number,
  fn: () => Promise<number>,
): Promise<number> {
  const start = Date.now();
  try {
    const exitCode = await fn();
    await logTimeline(config, {
      ts: new Date().toISOString(),
      event: "phase_done",
      phase,
      iteration,
      status: exitCode === 0 ? "ok" : "fail",
      durationMs: Date.now() - start,
    });
    return exitCode;
  } catch (err) {
    console.error(`${phase} phase crashed:`, err);
    await logTimeline(config, {
      ts: new Date().toISOString(),
      event: "phase_done",
      phase,
      iteration,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    return 1;
  }
}

/** Run a single respond → review → work iteration. Returns the exit code. */
export async function runIteration(config: AgentConfig, iteration: number, dryRun: boolean): Promise<number> {
  let exitCode = await runPhase(config, "respond", iteration, () => runRespond(config, { dryRun }));

  if (exitCode === 0) {
    exitCode = await runPhase(config, "review", iteration, () => runReview(config, { dryRun }));
  }

  if (exitCode === 0) {
    exitCode = await runPhase(config, "run", iteration, () => runAuto(config, { dryRun }));
  }

  return exitCode;
}

export async function runDaemon(config: AgentConfig, options: DaemonOptions): Promise<number> {
  let lastExitCode = 0;
  do {
    const iter = nextIteration();
    const startTime = Date.now();
    console.log(`\n━━━ Iteration ${iter} started at ${new Date().toISOString()} ━━━`);
    await logTimeline(config, { ts: new Date().toISOString(), event: "iteration_start", iteration: iter, status: "start" });

    lastExitCode = await runIteration(config, iter, options.dryRun);

    const totalMs = Date.now() - startTime;
    console.log(`━━━ Iteration ${iter} done (${totalMs}ms, exit ${lastExitCode}) ━━━\n`);
    await logTimeline(config, { ts: new Date().toISOString(), event: "iteration_end", iteration: iter, status: lastExitCode === 0 ? "ok" : "fail", durationMs: totalMs });

    if (!options.once) {
      await sleep(options.pollSeconds * 1000);
    }
  } while (!options.once);
  return lastExitCode;
}
