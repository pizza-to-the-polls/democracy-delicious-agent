import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { z } from "zod";
import dotenv from "dotenv";

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const modelRoleSchema = z.object({
  id: z.string().min(1),
  thinking: thinkingLevelSchema,
});

export const repositoryConfigSchema = z.object({
  nodeVersion: z.string().min(1),
  testDatabasePrefix: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
  checks: z.object({
    fix: z.string().min(1).optional(),
    targeted: z.string().min(1).optional(),
    full: z.array(z.string().min(1)).min(1),
  }),
});

const configSchema = z.object({
  github: z.object({
    organization: z.string().min(1),
    appId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    projectNumber: z.number().int().positive(),
    repositories: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).min(1),
  }),
  paths: z.object({
    githubPrivateKey: z.string().min(1),
    environmentFile: z.string().min(1),
    workspace: z.string().min(1),
  }),
  models: z.object({
    planner: modelRoleSchema,
    executor: modelRoleSchema,
    reviewer: modelRoleSchema,
  }),
  repositories: z.record(z.string(), repositoryConfigSchema),
  budget: z.object({
    dailyUsd: z.number().positive(),
    autonomousStopUsd: z.number().positive(),
    absoluteUsd: z.number().positive(),
  }),
  limits: z.object({
    globalConcurrency: z.number().int().positive(),
    issueWallClockMinutes: z.number().int().positive(),
    maxModelTurns: z.number().int().positive(),
    maxTestRuns: z.number().int().positive(),
    maxRepairCycles: z.number().int().nonnegative(),
  }),
}).superRefine((config, context) => {
  if (config.budget.dailyUsd > config.budget.autonomousStopUsd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget", "dailyUsd"],
      message: "dailyUsd must not exceed autonomousStopUsd",
    });
  }
  if (config.budget.autonomousStopUsd > config.budget.absoluteUsd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget", "autonomousStopUsd"],
      message: "autonomousStopUsd must not exceed absoluteUsd",
    });
  }
});

export type AgentConfig = z.infer<typeof configSchema>;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function loadConfig(configPath?: string): Promise<AgentConfig> {
  const path = configPath ? expandHome(configPath) : resolve(repositoryRoot(), "config/agent.yml");
  const source = await readFile(path, "utf8");
  const parsed = yaml.load(source);
  const config = configSchema.parse(parsed);

  const environmentFile = expandHome(config.paths.environmentFile);
  dotenv.config({ path: environmentFile, override: false, quiet: true });

  return config;
}
