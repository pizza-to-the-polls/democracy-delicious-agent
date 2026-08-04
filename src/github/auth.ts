import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
  repositorySelection: string;
}

export class GitHubAppAuth {
  private cachedToken?: InstallationToken;

  constructor(
    private readonly appId: number,
    private readonly installationId: number,
    private readonly privateKeyPath: string,
  ) {}

  private async createJwt(): Promise<string> {
    const privateKey = await readFile(this.privateKeyPath, "utf8");
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: String(this.appId),
    })}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  async getInstallationToken(forceRefresh = false): Promise<InstallationToken> {
    const refreshBefore = Date.now() + 5 * 60 * 1000;
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt.getTime() > refreshBefore) {
      return this.cachedToken;
    }

    const jwt = await this.createJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "democracy-delicious-agent",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub installation token exchange failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as InstallationTokenResponse;
    this.cachedToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at),
      permissions: data.permissions,
      repositorySelection: data.repository_selection,
    };
    return this.cachedToken;
  }
}
