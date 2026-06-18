// Pure mapping logic for repo-homepage-sync: turn the set of Ingress hosts a
// namespace serves, plus the ArgoCD Application that owns that namespace, into
// (owner/repo -> canonical https URL). Kept side-effect-free so it is unit
// testable without a cluster or GitHub.

export type RepoRef = { owner: string; repo: string };

// Cluster-self-sourced Applications are raw infra manifests (operators,
// platform, the cluster repo itself), not standalone deployed apps with their
// own GitHub repo whose homepage we'd want to set. We skip any Application
// sourced from these repos.
const INFRA_REPOS = new Set(["rivavolt/cluster"]);

// Parse a repoURL (with or without a trailing .git, https or git@) into
// owner/repo. Returns null for anything that isn't a github.com repo we own.
export function parseRepoURL(repoURL: string | undefined): RepoRef | null {
  if (!repoURL) return null;
  const m = repoURL.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (owner !== "rivavolt" && owner !== "andreivolt") return null;
  return { owner, repo };
}

export function isInfraRepo(ref: RepoRef): boolean {
  return INFRA_REPOS.has(`${ref.owner}/${ref.repo}`);
}

// Pick the canonical/primary URL among the hosts a repo serves. Preference:
// a public apex/sub of a real domain over a *.tail.avolt.net tailnet host and
// over the *.v.avolt.net infra-door host; among the same class, the shortest
// host (apex beats subdomain). Mirrors the original set-repo-homepages
// heuristic. Returns "" if there is no usable host.
export function canonicalUrl(hosts: Iterable<string>): string {
  let best = "";
  let bestClass = 99;
  for (const h of hosts) {
    if (!h) continue;
    let cls: number;
    if (h.endsWith(".tail.avolt.net")) cls = 3;
    else if (h.endsWith(".v.avolt.net")) cls = 2;
    else cls = 1; // public domain (alimcompta.fr, *.avolt.net subs, etc.)
    if (best === "" || cls < bestClass || (cls === bestClass && h.length < best.length)) {
      best = h;
      bestClass = cls;
    }
  }
  return best ? `https://${best}` : "";
}

// Decide whether to write `desired` over the repo's `current` homepage.
// Conservative: write when empty/missing, or when the current value is itself
// an *.avolt.net host we plausibly derived in a previous run (so a stale URL
// gets corrected). Never clobber a deliberate, different homepage. Never write
// when already equal (idempotent).
export function shouldUpdate(current: string | null | undefined, desired: string): boolean {
  if (!desired) return false;
  const cur = (current ?? "").trim();
  if (cur === desired) return false;
  if (cur === "") return true;
  return cur.includes("avolt.net");
}
