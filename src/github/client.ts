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
}
