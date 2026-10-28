import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "../config.js";
import { expandHome } from "../config.js";

export interface SessionResult {
  text: string;
  cost: number;
  turns: number;
  sessionFile?: string;
}

export type SessionRole = "planner" | "executor" | "reviewer";

const TRANSIENT_MODEL_ERROR =
  /terminated|timed out|timeout|\b(429|500|502|503|504)\b|overloaded|rate.?limit|provider returned error|connection error|fetch failed|socket hang up|ECONNRESET/i;

/** Provider-side stalls and rate limits are worth retrying on a fallback model.
 * Budget/credit errors are NOT transient — every fallback uses the same key, so
 * they must surface loudly instead of burning attempts. */
export function isTransientModelError(message: string | undefined): boolean {
  if (!message) return false;
  return TRANSIENT_MODEL_ERROR.test(message);
}

interface ModelRef {
  id: string;
  thinking: string;
}

function modelCandidates(role: AgentConfig["models"][SessionRole]): ModelRef[] {
  return [role, ...(role.fallbacks ?? [])];
}

function assistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const texts = message.content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n")
        .trim();
      if (texts) return texts;
      const thinking = message.content
        .filter((item) => item.type === "thinking")
        .map((item) => item.thinking ?? "")
        .join("\n")
        .trim();
      if (thinking) return thinking;
    }
  }
  return "";
}

export async function runAgentSession(options: {
  config: AgentConfig;
  role: SessionRole;
  cwd: string;
  prompt: string;
  tools: string[];
  systemAppend: string;
  sessionName: string;
}): Promise<SessionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const candidates = modelCandidates(options.config.models[options.role]);
  const deadline = Date.now() + options.config.limits.issueWallClockMinutes * 60_000;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const candidate = candidates[attempt];
    if (attempt > 0) {
      console.warn(
        `[dd-agent] ${options.role}: retrying on fallback model ${candidate.id} after: ${lastError?.message ?? "unknown error"}`,
      );
    }
    const sessionName = attempt === 0 ? options.sessionName : `${options.sessionName}-fb${attempt}`;
    try {
      return await runAttempt(options, candidate, sessionName, deadline);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Wall-clock and budget/credit errors must surface, not loop through fallbacks.
      if (/wall-clock limit/.test(lastError.message) || !isTransientModelError(lastError.message)) {
        throw lastError;
      }
    }
  }
  throw lastError;
}

async function runAttempt(
  options: Parameters<typeof runAgentSession>[0],
  modelConfig: ModelRef,
  sessionName: string,
  deadline: number,
): Promise<SessionResult> {
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY!);
  const model = modelRuntime.getModel("openrouter", modelConfig.id);
  if (!model) throw new Error(`OpenRouter model not found: ${modelConfig.id}`);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 4 },
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: false,
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((file) => file.path.startsWith(options.cwd)),
    }),
    appendSystemPrompt: [options.systemAppend],
  });
  await loader.reload();

  const sessionDir = resolve(expandHome(options.config.paths.workspace), "sessions", sessionName);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionManager = SessionManager.create(options.cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: modelConfig.thinking as ThinkingLevel,
    tools: options.tools,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });

  let turns = 0;
  let timeout: NodeJS.Timeout | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      turns++;
      if (turns > options.config.limits.maxModelTurns) void session.abort();
    }
  });
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`${options.role} exceeded ${options.config.limits.issueWallClockMinutes} minute wall-clock limit`);
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void session.abort();
        reject(new Error(`${options.role} exceeded ${options.config.limits.issueWallClockMinutes} minute wall-clock limit`));
      }, remainingMs);
    });
    await Promise.race([session.prompt(options.prompt), timeoutPromise]);
    const stats = session.getSessionStats();
    const text = assistantText(session.messages);
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    if (!text) {
      const error = lastAssistant && "errorMessage" in lastAssistant ? lastAssistant.errorMessage : undefined;
      throw new Error(`${options.role} produced no text${error ? `: ${error}` : ""}`);
    }
    return {
      text,
      cost: stats.cost,
      turns,
      sessionFile: session.sessionFile,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    session.dispose();
  }
}
