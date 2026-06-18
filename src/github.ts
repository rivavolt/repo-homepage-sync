import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { RepoRef } from "./derive.ts";
import { shouldUpdate } from "./derive.ts";
import { log } from "./log.ts";

// GitHub App auth, minted in-cluster from the rivavolt-ci App (the App key +
// installation id are projected from the cluster sops store, mirroring
// email2pr / renovate). Octokit's app auth strategy mints and caches a ~1h
// installation token and refreshes it transparently, so we never deal with
// JWTs or token expiry by hand.
export type GithubConfig = {
  appId: string;
  installationId: string;
  privateKey: string;
};

export function loadGithubConfig(): GithubConfig {
  const appId = process.env.GH_APP_ID;
  const installationId = process.env.GH_APP_INSTALLATION_ID;
  const keyFile = process.env.GH_APP_PRIVATE_KEY_FILE;
  if (!appId || !installationId || !keyFile) {
    throw new Error(
      "missing GH_APP_ID / GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY_FILE",
    );
  }
  return { appId, installationId, privateKey: readFileSync(keyFile, "utf8") };
}

export function makeOctokit(cfg: GithubConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
      installationId: cfg.installationId,
    },
  });
}

// True once we've observed the App lacks Repository Administration: write, so we
// stop hammering GitHub with PATCHes that can only 403. Re-armed by the periodic
// resync (a fresh process clears it), which is when a newly-granted permission
// gets picked up.
let administrationDenied = false;

export function permissionDenied(): boolean {
  return administrationDenied;
}

// Reconcile one repo's homepage to `desired`. Idempotent: reads the current
// homepage and only PATCHes when shouldUpdate() says so. Degrades gracefully on
// 403 (the App missing `administration:write`) — logs the exact missing
// permission once and disarms further writes instead of crashlooping.
export async function reconcileHomepage(
  octokit: Octokit,
  ref: RepoRef,
  desired: string,
): Promise<"updated" | "unchanged" | "skipped" | "forbidden" | "error"> {
  if (administrationDenied) return "skipped";
  const { owner, repo } = ref;
  let current: string | null = null;
  try {
    const got = await octokit.repos.get({ owner, repo });
    current = got.data.homepage ?? null;
  } catch (e: any) {
    log.warn(`get ${owner}/${repo} failed: ${e?.status ?? ""} ${e?.message ?? e}`);
    return "error";
  }

  if (!shouldUpdate(current, desired)) {
    if ((current ?? "") === desired) return "unchanged";
    log.info(`skip ${owner}/${repo}: keep deliberate homepage '${current}' (would set ${desired})`);
    return "skipped";
  }

  try {
    await octokit.repos.update({ owner, repo, homepage: desired });
    log.info(`set ${owner}/${repo} homepage -> ${desired} (was '${current ?? ""}')`);
    return "updated";
  } catch (e: any) {
    if (e?.status === 403) {
      administrationDenied = true;
      log.error(
        `403 from PATCH /repos/${owner}/${repo} (homepage). The rivavolt-ci ` +
          `App is missing the 'Repository administration: write' permission ` +
          `required to edit repo metadata. Grant it on the App and ACCEPT the ` +
          `pending org-install permission request, then restart this ` +
          `controller. Backing off all homepage writes until then. ` +
          `(message: ${e?.message ?? e})`,
      );
      return "forbidden";
    }
    log.warn(`patch ${owner}/${repo} failed: ${e?.status ?? ""} ${e?.message ?? e}`);
    return "error";
  }
}
