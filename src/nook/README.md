# Nook

Nook is Tau's bundled Cloudflare-backed static mini-app platform. It deploys static directories to wildcard subdomains and gives each site a small same-origin JSON KV API exposed through `window.nook`.

V0 scope is intentionally narrow:

- Cloudflare only: one Worker, R2 assets, a global Registry Durable Object, and one Site Durable Object per site.
- Static assets only. Build locally first, then deploy the output directory.
- Sites live at `https://<site>.<nook-domain>/`; there are no path-based app URLs or `workers.dev` fallback.
- Deploys are private by default. `--public` makes the active deployment public; omitting it on the next deploy makes the active deployment private again.
- Browser KV is per-site JSON state. It survives redeploys and is public-writable when the active deployment is public.

## setup

Install Wrangler yourself and authenticate it non-interactively with `CLOUDFLARE_API_TOKEN`.

```sh
tau nook setup --domain nook.example.com
```

Setup deploys the bundled Worker as `tau-nook`, creates the `tau-nook-assets` R2 bucket where possible, and prints the Tau config block to add after you create a Cloudflare Access service token:

```json
{
  "nook": {
    "domain": "nook.example.com",
    "accessClientId": "...",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  }
}
```

DNS and Cloudflare Access applications/policies are external V0 setup steps. Configure routes for both `nook.example.com` and `*.nook.example.com`. Configure Access according to your organization policy and service-token needs.

Destroy is intentionally explicit:

```sh
tau nook destroy --domain nook.example.com --yes
```

## deploy

```sh
tau nook deploy ./dist --site demo
tau nook deploy ./dist --site demo --public
```

Deploy requirements:

- `index.html` is required at the root.
- Hidden files and directories are rejected, including `.env`, `.git`, and `.DS_Store`.
- Symlinks are rejected.
- `/__nook/*` is reserved and cannot be deployed.
- Site slugs are lowercase subdomain labels with letters, numbers, and hyphens.
- Successful deploys exactly replace the active static asset set. KV data survives.

## browser SDK

The Worker injects `/__nook/client.js` into served HTML. App code can use:

```js
await window.nook.kv.put("settings", { theme: "dark" });
const settings = await window.nook.kv.get("settings");
await window.nook.kv.delete("settings");
const keys = await window.nook.kv.list({ prefix: "todos/" });
```

KV values must be JSON-serializable. Keys and total site KV storage have fixed guardrails in the Worker.

## CLI

```sh
tau nook skill
tau nook list
tau nook delete demo
tau nook kv get demo settings
tau nook kv put demo settings '{"theme":"dark"}'
tau nook kv delete demo settings
tau nook kv list demo --prefix todos/
```

The assistant-facing model tool named `nook` appears automatically when Tau config contains `nook`. All tool operations require `read-write` risk.
