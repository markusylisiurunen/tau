# Nook

Nook is Tau's bundled Cloudflare-backed static mini-app platform. It deploys static directories to path-based site URLs and gives each site a small same-origin JSON KV API exposed through `window.nook`.

V0 scope is intentionally narrow:

- Cloudflare only: one Worker, R2 assets, a global Registry Durable Object, and one Site Durable Object per site.
- Static assets only. Build locally first, then deploy the output directory.
- Sites live at `https://<nook-domain>/<site>/`; there are no wildcard subdomain app URLs or `workers.dev` fallback.
- Deploys are private by default. `--public` makes the active deployment public; omitting it on the next deploy makes the active deployment private again.
- Browser KV is per-site JSON state. It survives redeploys and is public-writable when the active deployment is public.

## setup

Install Wrangler yourself and authenticate it non-interactively with `CLOUDFLARE_API_TOKEN`.

```sh
tau nook setup \
  --domain nook.example.com \
  --zone-name example.com \
  --access-team-domain https://team.cloudflareaccess.com \
  --access-aud <access-application-audience>
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

DNS and Cloudflare Access applications/policies are external V0 setup steps. Setup configures a Worker route for `nook.example.com` in the supplied Cloudflare zone. Configure DNS and Access according to your organization policy and service-token needs.

The setup command writes the Access team domain and application audience into the Worker environment. The Worker validates Cloudflare Access JWTs by loading the Access JWKS from that team domain and checking the token issuer, audience, expiry, and signature. Tau sends service-token headers to Cloudflare Access for CLI/API calls, but the Worker never treats raw service-token headers as authentication.

Destroy is intentionally explicit:

```sh
tau nook destroy \
  --domain nook.example.com \
  --access-client-id <cloudflare-access-client-id> \
  --access-client-secret <cloudflare-access-client-secret> \
  --yes
```

Destroy first calls `https://<domain>/__nook/api/destroy` through Cloudflare Access to delete site Durable Object data and R2 objects, then deletes the Worker and R2 bucket with Wrangler. The Access client id and secret can also come from `NOOK_ACCESS_CLIENT_ID` and `NOOK_ACCESS_CLIENT_SECRET`.

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
- Site slugs are lowercase path labels with letters, numbers, and hyphens.
- Apps should use relative asset URLs or be built with a base path of `/<site>/`.
- Successful deploys exactly replace the active static asset set. KV data survives.
- Uploads are checked against the manifest byte size and SHA-256 digest.
- Each site can have at most three non-expired pending deploy sessions.
- Deployed asset URLs remain stable across deploys, so responses require cache revalidation.

## browser SDK

The Worker injects `/<site>/__nook/client.js` into served HTML. App code can use:

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
