# repo-homepage-sync

A small, single-concern in-cluster controller that keeps each app's GitHub repo
**homepage** field in sync with the app's live deployed URL.

A repo's homepage is the one-click "live site" link on its GitHub page, but
nothing keeps it pointed at where the app is actually served. The source of
truth for "where is this app served" is the live **Ingress** in the cluster;
the source of truth for "which repo owns this app" is the owning **ArgoCD
Application**'s `spec.source.repoURL`. This controller joins the two reactively.

## How it works

1. **Watch** — a Kubernetes Ingress informer (reactive, with relist/backoff)
   triggers a reconcile on any Ingress add/update/delete. A periodic full
   resync (default 10m) also catches ArgoCD Application/repoURL changes and
   re-arms the GitHub-permission backoff.
2. **Map** app → GitHub repo, in priority order:
   - explicit Ingress annotation `avolt.net/repo: owner/repo`;
   - else the owning ArgoCD Application's `spec.source.repoURL`, matched by the
     Ingress's namespace == the Application's `destination.namespace`.
   Shared install namespaces (`argocd`, `kube-system`, `default`) and
   infra-only repos (`rivavolt/cluster`) are excluded; ambiguous namespaces
   (two different app repos) require the explicit annotation.
3. **Derive** the canonical URL: among all hosts a repo's Ingresses serve,
   prefer a public domain over `*.v.avolt.net` over `*.tail.avolt.net`; among
   the same class the shortest host (apex beats subdomain).
4. **Reconcile** — `PATCH /repos/{owner}/{repo}` `homepage`, but only when it
   differs (idempotent) and only when the current homepage is empty or itself a
   previously-derived `*.avolt.net` URL. A deliberate, different homepage is
   never clobbered.

## Auth

GitHub auth is minted in-cluster from the **rivavolt-ci** GitHub App (id +
installation id + private key projected from the cluster sops store via the
`repo-homepage-sync-secrets` SopsSecret — the same App key the cluster already
uses for repo writes). Octokit's app-auth strategy mints and refreshes ~1h
installation tokens automatically.

Editing a repo's homepage requires the App's **Repository administration:
write** permission. If that is not yet granted, GitHub returns
`403 Resource not accessible by integration`; the controller logs the exact
missing permission, backs off all homepage writes (no crashloop), and keeps
serving. The next resync (or a restart) re-arms it, so a freshly-granted
permission is picked up without a redeploy.

## RBAC

The ServiceAccount has read-only ClusterRole access: `get/list/watch` on
`networking.k8s.io/ingresses` and `get/list` on `argoproj.io/applications`. No
write verbs anywhere in the cluster — the only mutation is the off-cluster
GitHub PATCH.

## Deploy

Deployed as an ArgoCD Application (`argocd/clusters/volt/apps/repo-homepage-sync.yaml`
in `rivavolt/cluster`), tailnet-only (no public ingress; a `tailsecure`-bound
ingress exposes only `/healthz`, `/readyz`, `/stats`). The image is built by
Nix in CI (`flake.nix` → `streamLayeredImage`, pushed to GHCR by skopeo,
mirrored to the tailnet registry), mirroring webhook-gateway.

## Dev

```
bun install
bun test          # pure mapping/derivation logic
bun x tsc --noEmit
bun run src/main.ts
```
