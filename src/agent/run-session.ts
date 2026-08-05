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
  const modelConfig = options.config.models[options.role];
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey("openrouter", apiKey);
  const model = modelRuntime.getModel("openrouter", modelConfig.id);
  if (!model) throw new Error(`OpenRouter model not found: ${modelConfig.id}`);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
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

  const sessionDir = resolve(expandHome(options.config.paths.workspace), "sessions", options.sessionName);
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
    const timeoutMs = options.config.limits.issueWallClockMinutes * 60_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void session.abort();
        reject(new Error(`${options.role} exceeded ${options.config.limits.issueWallClockMinutes} minute wall-clock limit`));
      }, timeoutMs);
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
