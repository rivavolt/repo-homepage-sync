import { existsSync } from "node:fs";
import * as k8s from "@kubernetes/client-node";
import { parseRepoURL, isInfraRepo, type RepoRef } from "./derive.ts";

// Namespaces that are shared install targets rather than an app's own runtime
// namespace: many ArgoCD Applications deploy *into* `argocd` (the previews
// dashboard, kyverno-stack, monitoring, the argocd server itself) while serving
// unrelated things, so namespace->repo is ambiguous there and we never infer a
// repo for an Ingress that lives in one of these. Such Ingresses must carry an
// explicit avolt.net/repo annotation to be mapped.
const SHARED_NAMESPACES = new Set(["argocd", "kube-system", "default"]);

// Cluster access. In-cluster the ServiceAccount token + CA are auto-loaded;
// out-of-cluster it falls back to the user's kubeconfig (handy for a dry-run
// from a workstation). We gate on the SA token file actually existing rather
// than try/catch, because loadFromCluster() can silently load an empty config
// (yielding an unparseable https://undefined:undefined URL) when only some of
// the in-cluster env is present.
const SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export function makeKube() {
  const kc = new k8s.KubeConfig();
  if (existsSync(SA_TOKEN)) kc.loadFromCluster();
  else kc.loadFromDefault();
  return kc;
}

export type IngressHost = { namespace: string; name: string; hosts: string[]; repoAnnotation?: string };

// Extract the hosts an Ingress serves plus the optional avolt.net/repo override
// annotation. Skips empty/wildcard hosts.
export function ingressHosts(ing: k8s.V1Ingress): IngressHost {
  const hosts: string[] = [];
  for (const rule of ing.spec?.rules ?? []) {
    if (rule.host && !rule.host.startsWith("*")) hosts.push(rule.host);
  }
  const repoAnnotation = ing.metadata?.annotations?.["avolt.net/repo"];
  return {
    namespace: ing.metadata?.namespace ?? "",
    name: ing.metadata?.name ?? "",
    hosts,
    repoAnnotation,
  };
}

// Build namespace -> RepoRef from the ArgoCD Applications. The owning repo of
// an app is the Application whose destination.namespace serves it, mapped to
// its spec.source.repoURL (or, for multi-source apps, spec.sources[].repoURL).
// Apps that don't parse to an owned github repo are simply absent from the map.
export async function namespaceRepoMap(kc: k8s.KubeConfig): Promise<Map<string, RepoRef>> {
  const co = kc.makeApiClient(k8s.CustomObjectsApi);
  const res: any = await co.listClusterCustomObject({
    group: "argoproj.io",
    version: "v1alpha1",
    plural: "applications",
  });
  return namespaceRepoMapFromItems(res.items ?? []);
}

// Pure split of the mapping so it can be unit-/dry-run-tested from raw
// Application JSON without a live API client.
export function namespaceRepoMapFromItems(items: any[]): Map<string, RepoRef> {
  const map = new Map<string, RepoRef>();
  // Namespaces seen targeted by two different owned, non-infra repos: ambiguous,
  // so we drop them from the map entirely (an explicit annotation is the only
  // safe mapping for those Ingresses).
  const conflicted = new Set<string>();
  for (const app of items ?? []) {
    const ns: string | undefined = app.spec?.destination?.namespace;
    if (!ns || SHARED_NAMESPACES.has(ns)) continue;
    const urls: (string | undefined)[] = [];
    if (app.spec?.source?.repoURL) urls.push(app.spec.source.repoURL);
    for (const s of app.spec?.sources ?? []) urls.push(s.repoURL);
    for (const u of urls) {
      const ref = parseRepoURL(u);
      if (!ref) continue;
      // Infra repos (rivavolt/cluster) deploy raw manifests into many app
      // namespaces; they never own an app's homepage, so they don't claim a ns.
      if (isInfraRepo(ref)) break;
      const existing = map.get(ns);
      if (existing && (existing.owner !== ref.owner || existing.repo !== ref.repo)) {
        conflicted.add(ns);
      } else if (!existing) {
        map.set(ns, ref);
      }
      break;
    }
  }
  for (const ns of conflicted) map.delete(ns);
  return map;
}

// Resolve an Ingress to its owning repo: explicit annotation wins, then the
// ArgoCD namespace map, then the app-name == repo-name convention (the Ingress's
// namespace name matched against the known repo, best-effort — only used when
// nothing else resolves).
export function resolveRepo(
  ih: IngressHost,
  nsMap: Map<string, RepoRef>,
): RepoRef | null {
  if (ih.repoAnnotation) return parseRepoURL(`https://github.com/${ih.repoAnnotation}`);
  if (SHARED_NAMESPACES.has(ih.namespace)) return null;
  return nsMap.get(ih.namespace) ?? null;
}

// List every Ingress in the cluster (used by the periodic full resync).
export async function listAllIngresses(kc: k8s.KubeConfig): Promise<k8s.V1Ingress[]> {
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const res = await net.listIngressForAllNamespaces();
  return res.items;
}
