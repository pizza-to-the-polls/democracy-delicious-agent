import { mkdir } from "node:fs/promises";
import type { AgentConfig } from "./config.js";
import type { z } from "zod";
import type { repositoryConfigSchema } from "./config.js";
import { assertSuccess, runProcess, runShell, type ProcessResult } from "./process.js";
import { sanitizedWorkerEnvironment } from "./security/environment.js";

export type RepositoryChecks = z.infer<typeof repositoryConfigSchema>["checks"];

export async function ensureTestDatabase(config: AgentConfig, repository: string, issueNumber: number): Promise<string | undefined> {
  const repoConfig = config.repositories[repository];
  if (!repoConfig.testDatabasePrefix) return undefined;
  const name = `${repoConfig.testDatabasePrefix}_${issueNumber}`;
  const exists = await runProcess("psql", ["-d", "postgres", "-Atc", `SELECT 1 FROM pg_database WHERE datname='${name}'`]);
  if (exists.stdout.trim() !== "1") assertSuccess(await runProcess("createdb", [name]));
  return name;
}

export async function installDependencies(config: AgentConfig, repository: string, cwd: string): Promise<void> {
  const repoConfig = config.repositories[repository];
  const command = `source "$HOME/.nvm/nvm.sh" && nvm use ${repoConfig.nodeVersion} >/dev/null && npm ci`;
  assertSuccess(await runShell(command, { cwd, env: sanitizedWorkerEnvironment(), timeoutMs: 10 * 60_000 }));
}

/**
 * Select the shell commands for a check run, in execution order.
 *
 * Pure helper so the (mutating!) fix-command decision is unit-testable.
 * The fix command rewrites worktree files (prettier/eslint --fix); modern
 * ESLint additionally strips unused disable directives during --fix, so
 * running it in --review-only mode would silently alter the very changes
 * under review.
 */
export function selectCommands(
  checks: RepositoryChecks,
  options: { targetedOnly?: boolean; skipFix?: boolean } = {},
): Array<{ command: string; kind: "fix" | "check" }> {
  const selected: Array<{ command: string; kind: "fix" | "check" }> = [];
  if (!options.skipFix && checks.fix) {
    selected.push({ command: checks.fix, kind: "fix" });
  }
  if (options.targetedOnly && checks.targeted) {
    selected.push({ command: checks.targeted, kind: "check" });
  } else {
    for (const check of checks.full) {
      selected.push({ command: check, kind: "check" });
    }
  }
  return selected;
}

export async function runChecks(options: {
  config: AgentConfig;
  repository: string;
  issueNumber: number;
  cwd: string;
  targetedOnly?: boolean;
  /** Skip the mutating auto-fix command (required for --review-only). */
  skipFix?: boolean;
}): Promise<ProcessResult[]> {
  const repoConfig = options.config.repositories[options.repository];
  const database = await ensureTestDatabase(options.config, options.repository, options.issueNumber);
  const env = sanitizedWorkerEnvironment({
    POSTGRES_DB: database,
    POSTGRES_USERNAME: process.env.USER,
    POSTGRES_PORT: "5432",
  });
  const results: ProcessResult[] = [];
  for (const { command, kind } of selectCommands(repoConfig.checks, options)) {
    const wrapped = `source "$HOME/.nvm/nvm.sh" && nvm use ${repoConfig.nodeVersion} >/dev/null && ${command}`;
    const result = await runShell(wrapped, { cwd: options.cwd, env, timeoutMs: 20 * 60_000 });
    results.push(result);
    // A failed fix shouldn't bail — let the reviewer see the raw lint output too.
    if (result.exitCode !== 0 && kind === "check") break;
  }
  return results;
}

export function formatCheckResults(results: ProcessResult[]): string {
  return results.map((result) => {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return `## ${result.command}\nexit=${result.exitCode}${result.timedOut ? " timed_out=true" : ""}\n\n${output.slice(-12000)}`;
  }).join("\n\n");
}
