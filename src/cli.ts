#!/usr/bin/env node
import { Command } from "commander";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { runAuto } from "./commands/run.js";
import { runReview } from "./commands/review.js";
import { runRespond } from "./commands/respond.js";
import { runDoctor } from "./commands/doctor.js";
import { runClean } from "./commands/clean.js";
import { runStatus } from "./commands/status.js";
import { runDaemon } from "./commands/daemon.js";
import { postBootstrapInstructions } from "./commands/post-instructions.js";
import { runWork } from "./commands/work.js";

const program = new Command();
program
  .name("democracy-agent")
  .description("Autonomous development orchestrator for Pizza to the Polls")
  .version("0.1.0")
  .option("-c, --config <path>", "path to agent YAML configuration");

function daemonOptions<T extends Command>(command: T): T {
  command
    .option("--once", "run a single iteration then exit", false)
    .option("--dry-run", "plan/review only, no mutations", false)
    .option("--poll <seconds>", "seconds to sleep between iterations when looping", (v) => Number.parseInt(v, 10), 300);
  return command;
}

daemonOptions(
  program
    .command("daemon")
    .description("continuous loop: respond → review → discover + work (default command)"),
).action(async (options: { once: boolean; dryRun: boolean; poll: number }) => {
  const config = await loadConfig(program.opts<{ config?: string }>().config);
  process.exitCode = await runDaemon(config, { once: options.once, dryRun: options.dryRun, pollSeconds: options.poll });
});

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
  .command("status")
  .description("show local agent state: locks, work state, worktrees, timeline, spend")
  .action(async () => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runStatus(config);
  });

program
  .command("clean")
  .description("remove orphaned worktrees; with --all also state files, sessions, stale locks")
  .option("--all", "remove all retained worktree/state/session data, not just orphans", false)
  .option("--dry-run", "preview what would be removed", false)
  .action(async (options: { all: boolean; dryRun: boolean }) => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runClean(config, { all: options.all, dryRun: options.dryRun });
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
daemonOptions(program).action(async (options: { once: boolean; dryRun: boolean; poll: number }) => {
  const config = await loadConfig(program.opts<{ config?: string }>().config);
  process.exitCode = await runDaemon(config, { once: options.once, dryRun: options.dryRun, pollSeconds: options.poll });
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
