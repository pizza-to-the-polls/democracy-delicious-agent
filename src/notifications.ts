/**
 * Optional outbound notifications (Slack incoming webhook).
 *
 * Config names the *environment variable* holding the webhook URL
 * (`notifications.webhookEnv`); the value is read at call time so tokens never
 * live in config files or state. Unset config or env var = silent no-op —
 * notifications are advisory and must never block or fail a run (fail-open).
 *
 * Posts plain text prefixed with the dd-agent tag. Deliberately no
 * username/icon overrides: posting identity belongs to the host that runs
 * the daemon (laptop = Democracy is Delicious Agent, bastion = Pizza Eagle);
 * the prefix makes the source unambiguous either way.
 */

import type { AgentConfig } from "./config.js";
import { budgetWarning, type OpenRouterUsage } from "./budget.js";

export async function postNotification(config: AgentConfig, text: string): Promise<boolean> {
  const envName = config.notifications?.webhookEnv;
  if (!envName) return false;
  const url = process.env[envName];
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[dd-agent] ${text}` }),
    });
    return response.ok;
  } catch {
    return false; // advisory only
  }
}

/** Log + (optionally) post the budget early warning. Never throws. */
export async function notifyBudgetWarning(
  config: AgentConfig,
  usage: OpenRouterUsage,
): Promise<string | null> {
  const warning = budgetWarning(usage, config.budget, config.budget.warnRemainingUsd);
  if (!warning) return null;
  console.warn(warning);
  await postNotification(config, warning);
  return warning;
}
