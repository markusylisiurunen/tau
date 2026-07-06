# Nook

Nook is Tau's bundled Cloudflare-only static mini-app platform. Keep V0 constrained to static assets plus per-site JSON KV.

- Do not add provider abstraction, dashboards, path-based app URLs, rollback/history, per-site server code, realtime, AI proxy APIs, ownership/roles, audit logs, `.gitignore`/`.nookignore`, or automatic DNS/Access setup in V0.
- Keep `src/nook/worker/` self-contained and Worker-native. Tau-side CLI, client, and model-tool code belongs under `src/core/nook/` and `src/core/tools/nook.ts`.
- The Worker must derive site scope from the hostname. Browser/CLI payloads must not be trusted to select another site's KV scope.
- `/__nook/*` is reserved and must never be served from user assets.
- Setup/destroy are CLI-only infrastructure flows. The model tool operates only an already configured Nook target.
