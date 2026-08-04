import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentConfig } from "../config.js";
import { expandHome, repositoryRoot } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";

export async function postBootstrapInstructions(config: AgentConfig): Promise<void> {
  const body = await readFile(resolve(repositoryRoot(), "docs/bootstrap-issue.md"), "utf8");
  const auth = new GitHubAppAuth(
    config.github.appId,
    config.github.installationId,
    expandHome(config.paths.githubPrivateKey),
  );
  const client = new GitHubClient(auth);
  const issue = await client.createIssue(
    `${config.github.organization}/democracy-delicious-agent`,
    "Bootstrap the Democracy Delicious Agent on the pizzaagent account",
    body,
  );
  console.log(`Created bootstrap issue #${issue.number}: ${issue.html_url}`);
}
