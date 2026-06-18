import * as k8s from "@kubernetes/client-node";
import { canonicalUrl, type RepoRef } from "./derive.ts";
import {
  makeKube,
  ingressHosts,
  namespaceRepoMap,
  resolveRepo,
  listAllIngresses,
} from "./k8s.ts";
import { loadGithubConfig, makeOctokit, reconcileHomepage, permissionDenied } from "./github.ts";
import { log } from "./log.ts";

const RESYNC_MS = Number(process.env.RESYNC_INTERVAL_MS ?? 10 * 60 * 1000);
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? 3000);
const PORT = Number(process.env.PORT ?? 8080);

const kc = makeKube();
const ghCfg = loadGithubConfig();
const octokit = makeOctokit(ghCfg);

// A reconcile pass: rebuild the namespace->repo map from ArgoCD, enumerate all
// Ingresses, group their hosts per owning repo, derive each repo's canonical
// URL, and reconcile it on GitHub. This is the single source of truth for what
// a repo's homepage should be; the informer just schedules it. Grouping per
// repo (not per Ingress) is what lets a repo with several Ingresses/hosts pick
// one canonical URL.
async function reconcileAll(reason: string) {
  try {
    const nsMap = await namespaceRepoMap(kc);
    const ingresses = await listAllIngresses(kc);
    const repoHosts = new Map<string, { ref: RepoRef; hosts: Set<string> }>();
    for (const ing of ingresses) {
      const ih = ingressHosts(ing);
      if (ih.hosts.length === 0) continue;
      const ref = resolveRepo(ih, nsMap);
      if (!ref) continue;
      const key = `${ref.owner}/${ref.repo}`;
      let bucket = repoHosts.get(key);
      if (!bucket) {
        bucket = { ref, hosts: new Set() };
        repoHosts.set(key, bucket);
      }
      for (const h of ih.hosts) bucket.hosts.add(h);
    }

    log.info(`reconcile (${reason}): ${repoHosts.size} repo(s) with served ingresses`);
    for (const { ref, hosts } of repoHosts.values()) {
      const url = canonicalUrl(hosts);
      if (!url) continue;
      const r = await reconcileHomepage(octokit, ref, url);
      if (permissionDenied()) {
        log.warn("permission denied — stopping this pass, will retry on next resync");
        break;
      }
      void r;
    }
  } catch (e: any) {
    log.error(`reconcile pass failed: ${e?.message ?? e}`);
  }
}

// Debounce informer events: bursts of Ingress changes (a rollout touching
// several at once) collapse into a single reconcile.
let pending: ReturnType<typeof setTimeout> | null = null;
function schedule(reason: string) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void reconcileAll(reason);
  }, DEBOUNCE_MS);
}

// Reactive: an Ingress informer (watch with auto-relist/backoff) drives
// reconciles on add/update/delete. The full reconcile re-derives everything, so
// we don't need the event payload beyond "something changed".
async function startInformer() {
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const informer = k8s.makeInformer(
    kc,
    "/apis/networking.k8s.io/v1/ingresses",
    () => net.listIngressForAllNamespaces(),
  );
  informer.on("add", (o) => schedule(`ingress add ${o.metadata?.namespace}/${o.metadata?.name}`));
  informer.on("update", (o) => schedule(`ingress update ${o.metadata?.namespace}/${o.metadata?.name}`));
  informer.on("delete", (o) => schedule(`ingress delete ${o.metadata?.namespace}/${o.metadata?.name}`));
  informer.on("error", (e: any) => {
    log.warn(`informer error, will resync: ${e?.message ?? e}`);
    setTimeout(() => informer.start(), 5000);
  });
  await informer.start();
  log.info("ingress informer started");
}

// Liveness/readiness for the tailnet ingress + k8s probes.
function startHealth() {
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        return new Response("ok\n");
      }
      if (url.pathname === "/stats") {
        return Response.json({ permissionDenied: permissionDenied() });
      }
      return new Response("repo-homepage-sync\n");
    },
  });
  log.info(`health server on :${PORT}`);
}

async function main() {
  log.info("repo-homepage-sync starting");
  startHealth();
  await reconcileAll("startup");
  await startInformer();
  // Periodic full resync: catches Application/repoURL changes (the informer
  // only watches Ingresses) and re-arms the permission backoff so a freshly
  // granted administration:write is picked up without a redeploy.
  setInterval(() => void reconcileAll("periodic resync"), RESYNC_MS);
}

void main();
