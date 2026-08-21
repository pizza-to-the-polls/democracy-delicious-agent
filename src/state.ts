import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import { expandHome } from "./config.js";

export type WorkPhase = "created" | "worktree-ready" | "planned" | "implemented" | "checked" | "reviewed" | "needs-repair" | "complete" | "failed";

export interface WorkState {
  repository: string;
  issueNumber: number;
  phase: WorkPhase;
  worktreePath?: string;
  branch?: string;
  plan?: string;
  review?: string;
  lastError?: string;
  /** Number of bounded repair cycles consumed (capped by limits.maxRepairCycles). */
  repairs?: number;
  costs: Record<string, number>;
  updatedAt: string;
}

export class StateStore {
  private readonly root: string;

  constructor(config: AgentConfig) {
    this.root = resolve(expandHome(config.paths.workspace), "state");
  }

  path(repository: string, issueNumber: number): string {
    return resolve(this.root, repository.replace("/", "--"), `${issueNumber}.json`);
  }

  async load(repository: string, issueNumber: number): Promise<WorkState | undefined> {
    try {
      return JSON.parse(await readFile(this.path(repository, issueNumber), "utf8")) as WorkState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: Omit<WorkState, "updatedAt"> | WorkState): Promise<WorkState> {
    const next = { ...state, updatedAt: new Date().toISOString() } as WorkState;
    const path = this.path(next.repository, next.issueNumber);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  }
}
