#!/usr/bin/env node
import { Command } from "commander";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { runAuto } from "./commands/run.js";
import { runReview } from "./commands/review.js";
import { runRespond } from "./commands/respond.js";
import { runDoctor } from "./commands/doctor.js";
import { postBootstrapInstructions } from "./commands/post-instructions.js";
import { runWork } from "./commands/work.js";
import { logTimeline, nextIteration } from "./timeline.js";

const program = new Command();
program
  .name("democracy-agent")
  .description("Autonomous development orchestrator for Pizza to the Polls")
  .version("0.1.0")
  .option("-c, --config <path>", "path to agent YAML configuration");

program
  .command("respond")
  .description("respond to human feedback on agent PRs")
  .option("--repo <owner/name>", "restrict to a single repository")
  .option("--dry-run", "show what would be done", false)
  .action(async (options: { repo?: string; dryRun: boolean }) => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runRespond(config, { dryRun: options.dryRun, repo: options.repo });
  });

program
  .command("review")
  .description("review open agent PRs on integration branches, merge if clean")
  .option("--repo <owner/name>", "restrict to a single repository")
  .option("--dry-run", "review only, do not merge", false)
  .action(async (options: { repo?: string; dryRun: boolean }) => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runReview(config, { dryRun: options.dryRun, repo: options.repo });
  });

program
  .command("doctor")
  .description("verify credentials, permissions, services, and local setup")
  .action(async () => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runDoctor(config);
  });

program
  .command("run")
  .description("auto-discover next agent:ready issue and work it")
  .option("--repo <owner/name>", "restrict to a single repository")
  .option("--dry-run", "plan only", false)
  .action(async (options: { repo?: string; dryRun: boolean }) => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runAuto(config, { repo: options.repo, dryRun: options.dryRun });
  });

program
  .command("work")
  .description("plan or implement one approved GitHub issue in an isolated worktree")
  .requiredOption("--repo <owner/name>", "approved GitHub repository")
  .requiredOption("--issue <number>", "GitHub issue number", (value) => Number.parseInt(value, 10))
  .option("--dry-run", "plan only; do not let the agent modify repository files", false)
  .option("--resume", "resume/reconcile existing local issue state", false)
  .option("--integration-branch <name>", "feature branch to target (child PRs merge here; umbrella PR to master later)")
  .option("--review-only", "run deterministic checks and independent review on the existing worktree", false)
  .action(async (options: { repo: string; issue: number; dryRun: boolean; resume: boolean; reviewOnly: boolean; integrationBranch?: string }) => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runWork(config, {
      repository: options.repo,
      issueNumber: options.issue,
      dryRun: options.dryRun,
      resume: options.resume,
      reviewOnly: options.reviewOnly,
      integrationBranch: options.integrationBranch,
    });
  });

program
  .command("post-instructions")
  .description("create the bootstrap instructions issue using the GitHub App")
  .action(async () => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    await postBootstrapInstructions(config);
  });

// Default: daemon loop — respond → review → discover.
program.action(async () => {
  const config = await loadConfig(program.opts<{ config?: string }>().config);

  const iter = nextIteration();
  const startTime = Date.now();
  console.log(`\n━━━ Iteration ${iter} started at ${new Date().toISOString()} ━━━`);
  await logTimeline(config, { ts: new Date().toISOString(), event: "iteration_start", iteration: iter, status: "start" });

  // Phase 1: respond to feedback.
  let exitCode: number;
  const respondStart = Date.now();
  try {
    exitCode = await runRespond(config, { dryRun: false });
    await logTimeline(config, { ts: new Date().toISOString(), event: "phase_done", phase: "respond", iteration: iter, status: exitCode === 0 ? "ok" : "fail", durationMs: Date.now() - respondStart });
  } catch (err) {
    console.error("respond phase crashed:", err);
    await logTimeline(config, { ts: new Date().toISOString(), event: "phase_done", phase: "respond", iteration: iter, status: "fail", detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - respondStart });
    exitCode = 1;
  }

  // Phase 2: review PRs.
  if (exitCode === 0) {
    const reviewStart = Date.now();
    try {
      exitCode = await runReview(config, { dryRun: false });
      await logTimeline(config, { ts: new Date().toISOString(), event: "phase_done", phase: "review", iteration: iter, status: exitCode === 0 ? "ok" : "fail", durationMs: Date.now() - reviewStart });
    } catch (err) {
      console.error("review phase crashed:", err);
      await logTimeline(config, { ts: new Date().toISOString(), event: "phase_done", phase: "review", iteration: iter, status: "fail", detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - reviewStart });
      exitCode = 1;
    }
  }

  // Phase 3: discover and work next issue.
  if (exitCode === 0) {
    const runStart = Date.now();
    try {
      exitCode = await runAuto(config, { dryRun: false });
      await logTimeline(config, { ts: new Date().toISOString(), event: "phase_done", phase: "run", iteration: iter, status: exitCode === 0 ? "ok" : "fail", durationMs: Date.now() - runStart });
    } catch (err) {
      console.error("run phase crashed:", err);
      await logTimeline(config, { ts: new Date().toISOString(), event: "phase_done", phase: "run", iteration: iter, status: "fail", detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - runStart });
      exitCode = 1;
    }
  }

  const totalMs = Date.now() - startTime;
  console.log(`━━━ Iteration ${iter} done (${totalMs}ms, exit ${exitCode}) ━━━\n`);
  await logTimeline(config, { ts: new Date().toISOString(), event: "iteration_end", iteration: iter, status: exitCode === 0 ? "ok" : "fail", durationMs: totalMs });

  process.exitCode = exitCode;
});

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof ZodError) {
    console.error("Invalid configuration:");
    for (const issue of error.issues) console.error(`- ${issue.path.join(".")}: ${issue.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}