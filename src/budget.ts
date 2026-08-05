export interface OpenRouterUsage {
  limit: number | null;
  remaining: number | null;
  usage: number;
  usageDaily: number;
}

export async function getOpenRouterUsage(): Promise<OpenRouterUsage> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`OpenRouter key usage request failed (${response.status})`);
  const payload = (await response.json()) as {
    data?: {
      limit?: number | null;
      limit_remaining?: number | null;
      usage?: number;
      usage_daily?: number;
    };
  };
  const data = payload.data;
  if (!data) throw new Error("OpenRouter key usage response contained no data");
  return {
    limit: data.limit ?? null,
    remaining: data.limit_remaining ?? null,
    usage: data.usage ?? 0,
    usageDaily: data.usage_daily ?? 0,
  };
}

export function assertBudgetAvailable(
  usage: OpenRouterUsage,
  limits: { dailyUsd: number; autonomousStopUsd: number; absoluteUsd: number },
  reserveUsd = 1,
): void {
  if (usage.usageDaily >= limits.dailyUsd) {
    throw new Error(`OpenRouter daily usage $${usage.usageDaily.toFixed(2)} reached local limit $${limits.dailyUsd.toFixed(2)}`);
  }
  if (usage.usage >= limits.autonomousStopUsd) {
    throw new Error(`OpenRouter usage $${usage.usage.toFixed(2)} reached autonomous stop $${limits.autonomousStopUsd.toFixed(2)}`);
  }
  if (usage.usage >= limits.absoluteUsd) {
    throw new Error(`OpenRouter usage $${usage.usage.toFixed(2)} reached absolute limit $${limits.absoluteUsd.toFixed(2)}`);
  }
  if (usage.remaining !== null && usage.remaining < reserveUsd) {
    throw new Error(`OpenRouter has only $${usage.remaining.toFixed(2)} remaining; $${reserveUsd.toFixed(2)} reserve required`);
  }
}
