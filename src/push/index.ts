import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { appendMarker, type UpstreamCheckMarker } from "../shared/marker.js";
import { createAppOctokit } from "../shared/octokit.js";
import { Git } from "./git.js";
import {
  buildBranchName,
  buildCommitUrl,
  buildRemoteUrl,
  isSameTarget,
  parsePrLabels,
  parseRepository,
} from "./helpers.js";
import {
  createSignedAmendedCommit,
  upsertBranchRef,
} from "./signed-commit.js";

interface TargetConfig {
  serverUrl: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

async function run(): Promise<void> {
  const ref = core.getInput("ref", { required: true });
  const targetServerUrl = core.getInput("target_server_url", { required: true });
  const repository = core.getInput("repository", { required: true });
  const baseBranch = core.getInput("base_branch") || "main";
  const mode = (core.getInput("mode") || "pr") as "direct" | "pr";
  const prLabels = parsePrLabels(core.getInput("pr_labels"));
  const checkName = core.getInput("check_name", { required: true });
  const branchPrefix = core.getInput("branch_prefix") || "cross-validation";
  const signCommit = core.getBooleanInput("sign_commit") || false;
  const workspace = core.getInput("workspace") || process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    throw new Error("workspace path not provided and GITHUB_WORKSPACE is unset.");
  }

  const upstreamAppId = core.getInput("upstream_app_id", { required: true });
  const upstreamPrivateKey = core.getInput("upstream_private_key", { required: true });
  const targetAppId = core.getInput("target_app_id", { required: true });
  const targetPrivateKey = core.getInput("target_private_key", { required: true });

  const { owner: targetOwner, repo: targetRepo } = parseRepository(repository);
  const target: TargetConfig = {
    serverUrl: targetServerUrl,
    owner: targetOwner,
    repo: targetRepo,
    baseBranch,
  };

  const ctx = github.context;
  const upstreamServer = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const upstreamOwner = ctx.repo.owner;
  const upstreamRepo = ctx.repo.repo;

  if (
    isSameTarget(
      upstreamServer,
      `${upstreamOwner}/${upstreamRepo}`,
      target.serverUrl,
      `${target.owner}/${target.repo}`
    )
  ) {
    core.notice(
      `target ${target.serverUrl}/${target.owner}/${target.repo} matches the current server+repo - skipping push to avoid circular validation.`
    );
    core.setOutput("skipped", "true");
    core.setOutput("check_run_id", "");
    core.setOutput("target_branch", "");
    core.setOutput("target_url", "");
    return;
  }

  const upstream = await createAppOctokit({
    appId: upstreamAppId,
    privateKey: upstreamPrivateKey,
    baseUrl: upstreamServer,
    owner: upstreamOwner,
    repo: upstreamRepo,
  });
  const targetOctokit = await createAppOctokit({
    appId: targetAppId,
    privateKey: targetPrivateKey,
    baseUrl: target.serverUrl,
    owner: target.owner,
    repo: target.repo,
  });

  const git = new Git({ cwd: workspace });
  await git.configIdentity(
    "cross-github-validation[bot]",
    "cross-github-validation@users.noreply.github.com"
  );

  const sha = await git.showCommitSha(ref);
  await git.checkoutDetached(sha);
  core.info(`resolved ref ${ref} -> ${sha}`);

  const checkRun = await createUpstreamCheck(
    upstream,
    upstreamOwner,
    upstreamRepo,
    sha,
    checkName,
    target
  );
  core.info(`created upstream check ${checkRun.id} (${checkRun.html_url})`);

  try {
    const marker: UpstreamCheckMarker = {
      server: upstreamServer,
      owner: upstreamOwner,
      repo: upstreamRepo,
      check_run_id: checkRun.id,
      check_run_url: checkRun.html_url ?? "",
    };

    const originalMessage = await git.showCommitMessage(sha);
    const amendedMessage = appendMarker(originalMessage, marker);
    const branch = buildBranchName(branchPrefix, sha);

    const targetToken = await getInstallationToken(targetOctokit);
    const remoteUrl = buildRemoteUrl(
      target.serverUrl,
      target.owner,
      target.repo,
      targetToken
    );
    await git.addRemote("target", remoteUrl);

    let pushedSha: string;
    if (signCommit) {
      pushedSha = await pushSignedAmend({
        git,
        octokit: targetOctokit,
        target,
        baseSha: sha,
        amendedMessage,
        branch,
      });
    } else {
      await git.amendCommitMessage(amendedMessage);
      pushedSha = await git.showCommitSha("HEAD");
      await git.pushForce("target", `HEAD:refs/heads/${branch}`, target.serverUrl);
    }

    let detailsUrl: string;
    if (mode === "direct") {
      detailsUrl = buildCommitUrl(
        target.serverUrl,
        target.owner,
        target.repo,
        pushedSha
      );
    } else {
      const pr = await upsertPullRequest(
        targetOctokit,
        target,
        branch,
        prLabels,
        sha
      );
      detailsUrl = pr.html_url;
    }

    await upstream.checks.update({
      owner: upstreamOwner,
      repo: upstreamRepo,
      check_run_id: checkRun.id,
      details_url: detailsUrl,
      output: {
        title: "Pushed to target",
        summary: `Pushed to ${target.serverUrl}/${target.owner}/${target.repo}@${branch}.\n\nDetails: ${detailsUrl}`,
      },
    });
    core.setOutput("skipped", "false");
    core.setOutput("check_run_id", String(checkRun.id));
    core.setOutput("target_branch", branch);
    core.setOutput("target_url", detailsUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upstream.checks
      .update({
        owner: upstreamOwner,
        repo: upstreamRepo,
        check_run_id: checkRun.id,
        status: "completed",
        conclusion: "failure",
        completed_at: new Date().toISOString(),
        output: {
          title: "Push failed",
          summary: `Failed to push to target ${target.serverUrl}/${target.owner}/${target.repo}:\n\n${message}`,
        },
      })
      .catch((err2) =>
        core.warning(`failed to mark upstream check failed: ${(err2 as Error).message}`)
      );
    throw err;
  }
}

async function createUpstreamCheck(
  upstream: Octokit,
  owner: string,
  repo: string,
  sha: string,
  name: string,
  target: TargetConfig
): Promise<{ id: number; html_url: string | null }> {
  const { data } = await upstream.checks.create({
    owner,
    repo,
    name,
    head_sha: sha,
    status: "queued",
    output: {
      title: "Queued",
      summary: `Cross-GitHub validation against ${target.serverUrl}/${target.owner}/${target.repo}.`,
    },
  });
  return { id: data.id, html_url: data.html_url };
}

async function pushSignedAmend(input: {
  git: Git;
  octokit: Octokit;
  target: TargetConfig;
  baseSha: string;
  amendedMessage: string;
  branch: string;
}): Promise<string> {
  const scratchBranch = `${input.branch}.scratch`;
  await input.git.pushForce(
    "target",
    `${input.baseSha}:refs/heads/${scratchBranch}`,
    input.target.serverUrl
  );

  try {
    const newSha = await createSignedAmendedCommit({
      octokit: input.octokit,
      owner: input.target.owner,
      repo: input.target.repo,
      baseSha: input.baseSha,
      amendedMessage: input.amendedMessage,
    });
    await upsertBranchRef({
      octokit: input.octokit,
      owner: input.target.owner,
      repo: input.target.repo,
      branch: input.branch,
      sha: newSha,
    });
    return newSha;
  } finally {
    try {
      await input.octokit.git.deleteRef({
        owner: input.target.owner,
        repo: input.target.repo,
        ref: `heads/${scratchBranch}`,
      });
    } catch (err) {
      core.warning(
        `failed to clean up scratch ref ${scratchBranch}: ${(err as Error).message}`
      );
    }
  }
}

async function upsertPullRequest(
  octokit: Octokit,
  target: TargetConfig,
  branch: string,
  labels: string[],
  upstreamSha: string
): Promise<{ html_url: string; number: number }> {
  const title = `cross-validation: ${upstreamSha.slice(0, 12)}`;
  const body = `Automated cross-GitHub validation push.\n\nUpstream commit: ${upstreamSha}\nTarget branch: ${branch}\n`;

  const existing = await octokit.pulls.list({
    owner: target.owner,
    repo: target.repo,
    head: `${target.owner}:${branch}`,
    state: "open",
    per_page: 1,
  });

  let pr: { html_url: string; number: number };
  if (existing.data.length > 0) {
    pr = {
      html_url: existing.data[0]!.html_url,
      number: existing.data[0]!.number,
    };
  } else {
    const created = await octokit.pulls.create({
      owner: target.owner,
      repo: target.repo,
      title,
      body,
      head: branch,
      base: target.baseBranch,
    });
    pr = { html_url: created.data.html_url, number: created.data.number };
  }

  if (labels.length > 0) {
    await octokit.issues.setLabels({
      owner: target.owner,
      repo: target.repo,
      issue_number: pr.number,
      labels,
    });
  }

  return pr;
}

async function getInstallationToken(octokit: Octokit): Promise<string> {
  const auth = (await octokit.auth({ type: "installation" })) as { token: string };
  if (!auth?.token) throw new Error("failed to obtain installation token from Octokit auth.");
  return auth.token;
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
