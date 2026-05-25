import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface AppAuthInput {
  appId: string | number;
  privateKey: string;
  baseUrl: string;
  owner: string;
  repo: string;
}

export async function createAppOctokit(input: AppAuthInput): Promise<Octokit> {
  const baseUrl = normalizeApiBaseUrl(input.baseUrl);

  const appOctokit = new Octokit({
    baseUrl,
    authStrategy: createAppAuth,
    auth: {
      appId: input.appId,
      privateKey: input.privateKey,
    },
  });

  let installation;
  try {
    installation = await appOctokit.apps.getRepoInstallation({
      owner: input.owner,
      repo: input.repo,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      throw new Error(
        `GitHub App ${input.appId} is not installed on ${input.owner}/${input.repo} at ${baseUrl}.`
      );
    }
    throw err;
  }

  return new Octokit({
    baseUrl,
    authStrategy: createAppAuth,
    auth: {
      appId: input.appId,
      privateKey: input.privateKey,
      installationId: installation.data.id,
    },
  });
}

export function normalizeApiBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, "");
  if (trimmed === "https://github.com") {
    return "https://api.github.com";
  }
  return `${trimmed}/api/v3`;
}
