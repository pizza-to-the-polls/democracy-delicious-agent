import type { GitHubAppAuth } from "./auth.js";

export class GitHubClient {
  constructor(private readonly auth: GitHubAppAuth) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const { token } = await this.auth.getInstallationToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    // Only default the Accept header if the caller didn't set one explicitly.
    // (e.g. getPullRequestDiff needs Accept: application/vnd.github.v3.diff)
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/vnd.github+json");
    }
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("User-Agent", "democracy-delicious-agent");

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status} ${response.statusText}): ${await response.text()}`);
    }
    return response;
  }

  async listInstallationRepositories(): Promise<string[]> {
    const response = await this.request("https://api.github.com/installation/repositories?per_page=100");
    const data = (await response.json()) as { repositories: Array<{ full_name: string }> };
    return data.repositories.map((repository) => repository.full_name).sort();
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.request("https://api.github.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${payload.errors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.data) throw new Error("GitHub GraphQL returned no data");
    return payload.data;
  }

  async getOrganizationProject(organization: string, number: number): Promise<{
    id: string;
    number: number;
    title: string;
    url: string;
  } | null> {
    const data = await this.graphql<{
      organization: {
        projectV2: { id: string; number: number; title: string; url: string } | null;
      } | null;
    }>(
      `query Project($organization: String!, $number: Int!) {
        organization(login: $organization) {
          projectV2(number: $number) { id number title url }
        }
      }`,
      { organization, number },
    );
    return data.organization?.projectV2 ?? null;
  }

  async getIssue(repository: string, number: number): Promise<{
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    labels: Array<{ name: string }>;
  }> {
    const response = await this.request(`https://api.github.com/repos/${repository}/issues/${number}`);
    return (await response.json()) as {
      number: number;
      title: string;
      body: string | null;
      state: string;
      html_url: string;
      labels: Array<{ name: string }>;
    };
  }

  async listIssueComments(repository: string, number: number): Promise<Array<{
    id: number;
    body: string;
    user: { login: string };
    html_url: string;
  }>> {
    const response = await this.request(`https://api.github.com/repos/${repository}/issues/${number}/comments?per_page=100`);
    return (await response.json()) as Array<{
      id: number;
      body: string;
      user: { login: string };
      html_url: string;
    }>;
  }

  async createIssue(repository: string, title: string, body: string, labels: string[] = []): Promise<{
    number: number;
    html_url: string;
  }> {
    const response = await this.request(`https://api.github.com/repos/${repository}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, labels }),
    });
    return (await response.json()) as { number: number; html_url: string };
  }

  async createPullRequest(repository: string, options: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<string> {
    const response = await this.request(`https://api.github.com/repos/${repository}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    const pr = (await response.json()) as { html_url: string };
    return pr.html_url;
  }

  async searchIssues(repository: string, labels: string[]): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
  }>> {
    const labelQuery = labels.map(encodeURIComponent).join(",");
    const response = await this.request(
      `https://api.github.com/repos/${repository}/issues?labels=${labelQuery}&state=open&per_page=10&sort=created&direction=asc`
    );
    const issues = (await response.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
      pull_request?: unknown;
    }>;
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body,
        labels: i.labels.map((l) => l.name),
      }));
  }

  async listOpenPullRequests(repository: string): Promise<Array<{
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
    html_url: string;
  }>> {
    const response = await this.request(
      `https://api.github.com/repos/${repository}/pulls?state=open&per_page=20`
    );
    const prs = (await response.json()) as Array<{
      number: number;
      title: string;
      head: { ref: string };
      base: { ref: string };
      html_url: string;
    }>;
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.head.ref,
      baseRefName: pr.base.ref,
      html_url: pr.html_url,
    }));
  }

  // ---- Pull request detail ---------------------------------------------------

  async getPullRequest(repository: string, number: number): Promise<{
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
    html_url: string;
    labels: Array<{ name: string }>;
  }> {
    const response = await this.request(
      `https://api.github.com/repos/${repository}/pulls/${number}`
    );
    const pr = (await response.json()) as {
      number: number;
      title: string;
      head: { ref: string };
      base: { ref: string };
      html_url: string;
      labels: Array<{ name: string }>;
    };
    return {
      number: pr.number,
      title: pr.title,
      headRefName: pr.head.ref,
      baseRefName: pr.base.ref,
      html_url: pr.html_url,
      labels: pr.labels,
    };
  }

  async getPullRequestChecks(repository: string, number: number): Promise<Array<{
    name: string;
    conclusion: string | null;
    status: string;
  }>> {
    // Get the head SHA first.
    const pr = await this.getPullRequest(repository, number);

    // Use the checks API via the ref name.
    const response = await this.request(
      `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(pr.headRefName)}/check-runs?per_page=50`
    );
    const data = (await response.json()) as {
      check_runs: Array<{ name: string; conclusion: string | null; status: string }>;
    };
    return data.check_runs.map((check) => ({
      name: check.name,
      conclusion: check.conclusion,
      status: check.status,
    }));
  }

  async listPullRequestComments(repository: string, number: number): Promise<Array<{
    id: number;
    body: string;
    user: { login: string };
  }>> {
    const response = await this.request(
      `https://api.github.com/repos/${repository}/pulls/${number}/comments?per_page=100`
    );
    return (await response.json()) as Array<{
      id: number;
      body: string;
      user: { login: string };
    }>;
  }

  async getPullRequestDiff(repository: string, number: number): Promise<string> {
    const response = await this.request(
      `https://api.github.com/repos/${repository}/pulls/${number}`,
      { headers: { Accept: "application/vnd.github.v3.diff" } },
    );
    return response.text();
  }

  // ---- Labels ----------------------------------------------------------------

  async addPullRequestLabel(repository: string, number: number, label: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${repository}/issues/${number}/labels`,
      { method: "POST", body: JSON.stringify({ labels: [label] }) },
    );
  }

  async addIssueLabel(repository: string, number: number, label: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${repository}/issues/${number}/labels`,
      { method: "POST", body: JSON.stringify({ labels: [label] }) },
    );
  }

  async removeIssueLabel(repository: string, number: number, label: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" },
    );
  }

  // ---- Merge -----------------------------------------------------------------

  async mergePullRequest(repository: string, number: number, headBranch: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${repository}/pulls/${number}/merge`,
      {
        method: "PUT",
        body: JSON.stringify({
          merge_method: "squash",
          commit_title: `Merge agent PR #${number}: ${headBranch}`,
        }),
      },
    );
  }

  // ---- Comments on PRs -------------------------------------------------------

  async addPullRequestComment(repository: string, number: number, body: string): Promise<string> {
    const response = await this.request(
      `https://api.github.com/repos/${repository}/issues/${number}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    const comment = (await response.json()) as { html_url: string };
    return comment.html_url;
  }

  // ---- Linked issues ---------------------------------------------------------

  async getLinkedIssues(repository: string, number: number): Promise<Array<{
    number: number;
    title: string;
  }>> {
    const pr = await this.request(
      `https://api.github.com/repos/${repository}/pulls/${number}`
    );
    const data = (await pr.json()) as { body: string | null };
    const body = data.body ?? "";

    // Parse closing keywords: closes/fixes/resolves #NNN
    const linked: Array<{ number: number; title: string }> = [];
    const regex = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      linked.push({ number: Number.parseInt(match[1], 10), title: "" });
    }
    return linked;
  }
}