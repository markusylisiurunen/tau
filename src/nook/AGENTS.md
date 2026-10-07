# Nook

Nook is Tau's bundled static mini-app platform, built only on Cloudflare (Worker, R2, Durable Objects). Sites are static assets at path-based URLs, and each site has a small same-origin JSON KV store. V0 is deliberately narrow. Keep it that way unless the user asks to widen it.

## Scope

- **Supported:** static hosting, Nook-hosted editable templates, per-site JSON KV, private and public active deployments, the CLI (setup, destroy, deploy, list, delete, template, KV), and the `nook` code-mode capability.
- **Do not add in V0:** a provider abstraction, dashboards, wildcard subdomain URLs, rollback or history, per-site server code, realtime, AI proxy APIs, ownership or roles, audit logs, `.gitignore`/`.nookignore` handling, or automatic DNS and Cloudflare Access setup.
- Users build apps outside Nook and deploy the output directory. Never add bundler-specific behavior to the Worker.

## Where things are

- `src/nook/worker/`: the self-contained Worker. Keep it Worker-native, with no Tau runtime imports.
- `src/core/nook/`: Tau-side CLI, client, setup, and deploy.
- `src/core/code_mode/nook.ts`: the trusted parent-side bridge for the code-mode capability, covering validation and file access through the execution backend. Its API reference is in `src/core/static/code_mode/nook/`.
- `docs/nook.md`: the public reference.

## Security and tenancy

- **Site scope comes from the URL.** The Worker derives it from the first path segment. Browser, CLI, and tool payloads can never select another site's KV.
- `/__nook/*` is reserved for platform endpoints and is never served from user assets.
- Setup and destroy are CLI-only. The model-facing capability operates only an already configured target.
- Generated code gets no credentials and no ambient filesystem, process, environment, network, import, timer, or raw-request authority. File and process access comes only from the separately enabled `tau.bash` capability. The host parent makes the authenticated Nook HTTP calls.
- **Access topology:**
  - Cloudflare Access protects only the root `/__nook/*` control plane, with its cookie Path attribute disabled.
  - Public site paths reach the Worker anonymously. Private site navigation authenticates through `/__nook/auth`, after which the Worker validates the hostname-scoped Access JWT.
  - Browser KV is at `/<site>/__nook/kv/*`. CLI and tool KV is at `/__nook/api/sites/<site>/kv/*`.
- Service-token headers only get a request past Access. Worker authorization relies on validated Access JWT claims, never on the raw headers.
