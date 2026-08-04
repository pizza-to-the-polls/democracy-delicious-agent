import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { AgentConfig } from "../config.js";
import { expandHome } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

function format(result: CheckResult): string {
  const symbol = result.status === "pass" ? "✓" : result.status === "warn" ? "!" : "✗";
  return `${symbol} ${result.name}: ${result.detail}`;
}

async function checkPrivateKey(path: string): Promise<CheckResult> {
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    const permissions = info.mode & 0o777;
    if ((permissions & 0o077) !== 0) {
      return { name: "GitHub private key", status: "fail", detail: `${path} must be mode 600 (currently ${permissions.toString(8)})` };
    }
    return { name: "GitHub private key", status: "pass", detail: `${path} is readable and private` };
  } catch (error) {
    return { name: "GitHub private key", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkOpenRouter(): Promise<CheckResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { name: "OpenRouter", status: "fail", detail: "OPENROUTER_API_KEY is not set in the protected environment file" };
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return { name: "OpenRouter", status: "fail", detail: `authentication failed (${response.status})` };
    const payload = (await response.json()) as { data?: { limit?: number | null; usage?: number; limit_remaining?: number | null } };
    const data = payload.data;
    const limit = data?.limit == null ? "no provider-side limit reported" : `$${data.limit.toFixed(2)} limit`;
    const remaining = data?.limit_remaining == null ? "" : `, $${data.limit_remaining.toFixed(2)} remaining`;
    return { name: "OpenRouter", status: "pass", detail: `authenticated; ${limit}${remaining}` };
  } catch (error) {
    return { name: "OpenRouter", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runDoctor(config: AgentConfig): Promise<number> {
  const results: CheckResult[] = [];
  const keyPath = expandHome(config.paths.githubPrivateKey);
  const workspace = expandHome(config.paths.workspace);

  results.push({ name: "Node.js", status: Number(process.versions.node.split(".")[0]) >= 20 ? "pass" : "fail", detail: process.version });
  results.push(await checkPrivateKey(keyPath));

  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await access(workspace, constants.R_OK | constants.W_OK);
    results.push({ name: "Workspace", status: "pass", detail: workspace });
  } catch (error) {
    results.push({ name: "Workspace", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const auth = new GitHubAppAuth(config.github.appId, config.github.installationId, keyPath);
    const token = await auth.getInstallationToken();
    const client = new GitHubClient(auth);
    results.push({ name: "GitHub App authentication", status: "pass", detail: `token expires ${token.expiresAt.toISOString()}` });

    const actual = await client.listInstallationRepositories();
    const expected = [...config.github.repositories].sort();
    const unexpected = actual.filter((repo) => !expected.includes(repo));
    const missing = expected.filter((repo) => !actual.includes(repo));
    if (unexpected.length || missing.length) {
      results.push({
        name: "GitHub repository boundary",
        status: "fail",
        detail: `unexpected=[${unexpected.join(", ") || "none"}], missing=[${missing.join(", ") || "none"}]`,
      });
    } else {
      results.push({ name: "GitHub repository boundary", status: "pass", detail: actual.join(", ") });
    }

    const dangerous = ["administration", "environments", "secrets", "workflows"].filter((permission) => permission in token.permissions);
    results.push({
      name: "Critical GitHub permissions",
      status: dangerous.length ? "fail" : "pass",
      detail: dangerous.length ? `unexpected permissions: ${dangerous.join(", ")}` : "no administration, environment, secrets, or workflow permission",
    });

    const extra = Object.keys(token.permissions).filter((permission) => ![
      "actions", "checks", "contents", "issues", "members", "metadata", "organization_projects", "pull_requests", "statuses",
    ].includes(permission));
    if (extra.length) {
      results.push({ name: "Additional GitHub capabilities", status: "warn", detail: `${extra.join(", ")} (installed intentionally; future runtime tokens will be downscoped)` });
    }

    const project = await client.getOrganizationProject(config.github.organization, config.github.projectNumber);
    results.push(project
      ? { name: "GitHub Project", status: "pass", detail: `${project.title} (${project.url})` }
      : { name: "GitHub Project", status: "fail", detail: `Project #${config.github.projectNumber} was not found` });
  } catch (error) {
    results.push({ name: "GitHub", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  results.push(await checkOpenRouter());

  const environmentPath = expandHome(config.paths.environmentFile);
  try {
    const info = await stat(environmentPath);
    const permissions = info.mode & 0o777;
    results.push({
      name: "Environment file",
      status: (permissions & 0o077) === 0 ? "pass" : "fail",
      detail: `${environmentPath} mode ${permissions.toString(8)}`,
    });
  } catch {
    results.push({ name: "Environment file", status: "fail", detail: `${environmentPath} is missing` });
  }

  console.log("Democracy Delicious Agent — system doctor\n");
  for (const result of results) console.log(format(result));
  console.log();

  const failures = results.filter((result) => result.status === "fail").length;
  const warnings = results.filter((result) => result.status === "warn").length;
  console.log(`${results.length - failures - warnings} passed, ${warnings} warnings, ${failures} failed`);
  return failures ? 1 : 0;
}
