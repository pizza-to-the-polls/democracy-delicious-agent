#!/usr/bin/env node
import { Command } from "commander";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { runDoctor } from "./commands/doctor.js";
import { postBootstrapInstructions } from "./commands/post-instructions.js";
import { runWork } from "./commands/work.js";

const program = new Command();
program
  .name("democracy-agent")
  .description("Autonomous development orchestrator for Pizza to the Polls")
  .version("0.1.0")
  .option("-c, --config <path>", "path to agent YAML configuration");

program
  .command("doctor")
  .description("verify credentials, permissions, services, and local setup")
  .action(async () => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runDoctor(config);
  });

program
  .command("work")
  .description("plan or implement one approved GitHub issue in an isolated worktree")
  .requiredOption("--repo <owner/name>", "approved GitHub repository")
  .requiredOption("--issue <number>", "GitHub issue number", (value) => Number.parseInt(value, 10))
  .option("--dry-run", "plan only; do not let the agent modify repository files", false)
  .option("--resume", "resume/reconcile existing local issue state", false)
  .action(async (options: { repo: string; issue: number; dryRun: boolean; resume: boolean }) => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    process.exitCode = await runWork(config, {
      repository: options.repo,
      issueNumber: options.issue,
      dryRun: options.dryRun,
      resume: options.resume,
    });
  });

program
  .command("post-instructions")
  .description("create the bootstrap instructions issue using the GitHub App")
  .action(async () => {
    const config = await loadConfig(program.opts<{ config?: string }>().config);
    await postBootstrapInstructions(config);
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
