import { expandHome, type AgentConfig } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";

/**
 * Mint a short-lived (~1h) GitHub App installation token so manual recovery
 * operations (creating a PR for a retained worktree's pushed branch, pushing
 * a fixup commit) are attributed to the agent bot instead of the operator's
 * personal account. PRs #310 and #143 were created with the operator's own
 * `gh` credentials during recovery and show a human as author.
 *
 * Usage:
 *   npm --prefix ~/Projects/democracy-delicious-agent run -s agent -- token
 *   → prints the raw token; feed it to gh via GH_TOKEN=<token>.
 */
export async function runToken(config: AgentConfig, options: { json?: boolean } = {}): Promise<number> {
  const keyPath = expandHome(config.paths.githubPrivateKey);
  const auth = new GitHubAppAuth(config.github.appId, config.github.installationId, keyPath);
  const { token, expiresAt, permissions } = await auth.getInstallationToken();
  if (options.json) {
    console.log(JSON.stringify({ token, expiresAt: expiresAt.toISOString(), permissions }, null, 2));
  } else {
    console.log(token);
  }
  return 0;
}
