import { mkdir } from "node:fs/promises";
import type { AgentConfig } from "./config.js";
import { assertSuccess, runProcess, runShell, type ProcessResult } from "./process.js";
import { sanitizedWorkerEnvironment } from "./security/environment.js";

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

export async function runChecks(options: {
  config: AgentConfig;
  repository: string;
  issueNumber: number;
  cwd: string;
  targetedOnly?: boolean;
}): Promise<ProcessResult[]> {
  const repoConfig = options.config.repositories[options.repository];
  const database = await ensureTestDatabase(options.config, options.repository, options.issueNumber);
  const env = sanitizedWorkerEnvironment({
    POSTGRES_DB: database,
    POSTGRES_USERNAME: process.env.USER,
    POSTGRES_PORT: "5432",
  });
  const checks = options.targetedOnly && repoConfig.checks.targeted
    ? [repoConfig.checks.targeted]
    : repoConfig.checks.full;
  const results: ProcessResult[] = [];
  for (const check of checks) {
    const wrapped = `source "$HOME/.nvm/nvm.sh" && nvm use ${repoConfig.nodeVersion} >/dev/null && ${check}`;
    const result = await runShell(wrapped, { cwd: options.cwd, env, timeoutMs: 20 * 60_000 });
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
}

export function formatCheckResults(results: ProcessResult[]): string {
  return results.map((result) => {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return `## ${result.command}\nexit=${result.exitCode}${result.timedOut ? " timed_out=true" : ""}\n\n${output.slice(-12000)}`;
  }).join("\n\n");
}
