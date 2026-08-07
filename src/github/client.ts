import type { GitHubAppAuth } from "./auth.js";

export class GitHubClient {
  constructor(private readonly auth: GitHubAppAuth) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const { token } = await this.auth.getInstallationToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/vnd.github+json");
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
      .filter((i) => !i.pull_request) // Exclude PRs from issue search
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
    html_url: string;
  }>> {
    const response = await this.request(
      `https://api.github.com/repos/${repository}/pulls?state=open&per_page=20`
    );
    const prs = (await response.json()) as Array<{
      number: number;
      title: string;
      head: { ref: string };
      html_url: string;
    }>;
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.head.ref,
      html_url: pr.html_url,
    }));
  }
}
