# Deploy history from GitHub releases

Repository maintainers can enable an optional history deployment in the npm release workflow. It runs after npm publication succeeds, builds the published release tag, and applies the same migrations and Worker setup as `tau history setup`. It runs for every published release, including prereleases, and does not upgrade any hosts. Enable it only if this service should follow every release from that repository.

Create a GitHub Actions environment named `history` with these secrets:

- `CLOUDFLARE_API_TOKEN`: a token authorized to deploy the Worker, manage its secrets and route, and manage D1 in the target account and zone.
- `CLOUDFLARE_ACCOUNT_ID`: the target account.
- `TAU_HISTORY_DOMAIN`: the service hostname.
- `TAU_HISTORY_ZONE_NAME`: the containing Cloudflare zone.
- `TAU_HISTORY_API_KEY`: the service's existing API key.
- `TAU_HISTORY_VIEWER_PASSWORD`: its existing, separate viewer password.

Set the repository Actions variable `HISTORY_DEPLOY_ENABLED` to `true`. Deployment is disabled when the variable is absent. Keep domains and account identifiers in secrets too, rather than repository files or public variables. Configure environment protection rules to restrict which release tags may deploy; required approvals make deployment wait for approval.

All six values are required before deployment can start, so missing credentials never cause automatic password generation or rotation. Deployment logs report success or a generic failure without printing Wrangler diagnostics, hostnames, or configuration. Inspect failures privately in Cloudflare and check the configured secrets. No deployment logs are uploaded as artifacts.

Deployments are serialized without cancelling an active deployment. Avoid overlapping releases: GitHub concurrency does not guarantee release ordering. If deployment fails after npm publication, rerun the failed deployment job after correcting the problem; the package is already published. Do not rerun an older release after a newer one has deployed, because that would redeploy the older Worker.
