# Nook

Tau's Nook subtree contains the bundled Cloudflare-only static mini-app platform. Keep V0 narrow and explicit: static assets are deployed to wildcard subdomains, each site gets small same-origin JSON KV, and all infrastructure assumptions are Cloudflare Worker/R2/Durable Object based.

## Scope

- Supported: static asset hosting, per-site JSON KV, private/public active deployments, CLI setup/destroy/deploy/list/delete/KV operations, and the configured `nook` model tool.
- Unsupported in V0: provider abstraction, dashboards, path-based app URLs, rollback/history, per-site server code, realtime, AI proxy APIs, ownership/roles, audit logs, `.gitignore`/`.nookignore`, and automatic DNS or Cloudflare Access setup.
- Build app artifacts outside Nook, then deploy the output directory. Do not add bundler-specific behavior to the Worker.

## Architecture

- `src/nook/worker/` is the self-contained Worker implementation. Keep Worker code Worker-native and avoid Tau runtime dependencies there.
- `src/core/nook/` owns Tau-side CLI/client/setup/deploy helpers.
- `src/core/tools/nook.ts` owns the assistant-facing model tool for an already configured Nook target.
- `src/nook/README.md` is the user-facing reference for setup, deploy, browser SDK, CLI, and V0 behavior.

## Security and tenancy

- The Worker must derive site scope from the hostname. Browser, CLI, and tool payloads must not be trusted to select another site's KV scope.
- `/__nook/*` is reserved for platform endpoints and must never be served from user assets.
- Setup and destroy are CLI-only infrastructure flows. The model tool must operate only an already configured Nook target.
- Cloudflare Access service-token headers are only for passing Access. Worker authorization must rely on validated Access JWT claims, not raw service-token headers.
