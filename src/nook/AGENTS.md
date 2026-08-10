# Nook

Tau's Nook subtree contains the bundled Cloudflare-only static mini-app platform. Keep V0 narrow and explicit: static assets are deployed to path-based site URLs, each site gets small same-origin JSON KV, and all infrastructure assumptions are Cloudflare Worker/R2/Durable Object based.

## Scope

- Supported: static asset hosting, Nook-hosted editable templates, per-site JSON KV, private/public active deployments, CLI setup/destroy/deploy/list/delete/template/KV operations, and the configured `nook` model tool.
- Unsupported in V0: provider abstraction, dashboards, wildcard subdomain app URLs, rollback/history, per-site server code, realtime, AI proxy APIs, ownership/roles, audit logs, `.gitignore`/`.nookignore`, and automatic DNS or Cloudflare Access setup.
- Build app artifacts outside Nook, then deploy the output directory. Do not add bundler-specific behavior to the Worker.

## Architecture

- `src/nook/worker/` is the self-contained Worker implementation. Keep Worker code Worker-native and avoid Tau runtime dependencies there.
- `src/core/nook/` owns Tau-side CLI/client/setup/deploy helpers.
- `src/core/tools/nook.ts` owns the parent-side bridge, validation, and execution-environment file operations for the assistant-facing code-mode tool. `src/core/static/code_mode/nook/` owns its static SDK docs and SES sandbox facade.
- `src/nook/README.md` is the user-facing reference for setup, deploy, browser SDK, CLI, and V0 behavior.

## Security and tenancy

- The Worker must derive site scope from the first URL path segment. Browser, CLI, and tool payloads must not be trusted to select another site's KV scope.
- `/__nook/*` is reserved for platform endpoints and must never be served from user assets.
- Setup and destroy are CLI-only infrastructure flows. The model tool must operate only an already configured Nook target. Generated code receives no credentials, ambient filesystem, process, environment, network, import, timer, or raw request authority; the shared code-mode runtime separately exposes bounded agent-scoped UTF-8 scratch files. The host parent owns authenticated Nook HTTP and uses the generic execution backend for agent-visible paths.
- Cloudflare Access protects only the root `/__nook/*` control-plane path, with its Cookie Path Attribute disabled. Public site paths reach the Worker anonymously; private site navigation authenticates through `/__nook/auth`, then relies on the Worker's validation of the hostname-scoped Access JWT. Browser KV remains under `/<site>/__nook/kv/*`, while CLI/tool KV uses `/__nook/api/sites/<site>/kv/*`.
- Cloudflare Access service-token headers are only for passing Access. Worker authorization must rely on validated Access JWT claims, not raw service-token headers.
