# Nook

Nook is Tau's optional platform for publishing small static applications at path-based URLs. It combines built front-end assets with per-site JSON KV, while keeping deployment and authenticated management under Tau's host-owned Nook client.

Nook is intentionally narrow in V0. It is a Cloudflare-only static host, not a general application runtime. Build an app before deploying it. Nook does not run per-site server code, provision custom domains per app, provide rollback history, or turn a source repository into a build pipeline.

## V0 at a glance

A Nook deployment has one configured hostname and many sites:

```text
https://apps.example.net/roadmap/
https://apps.example.net/release-notes/
```

Each site has one active static deployment, a visibility of `private` or `public`, and independent JSON KV that survives redeploys. Templates are separately stored editable directory snapshots. They can be copied to a working directory, changed and built with ordinary tools, then deployed explicitly.

V0 does not provide dashboards, wildcard subdomain site URLs, deploy rollback, audit logs, ownership roles, realtime APIs, AI proxy APIs, ignore files, or provider abstraction. `.gitignore` and `.nookignore` have no special meaning. The deploy directory itself must contain only the files intended for publication.

## Ownership and apply boundaries

Nook crosses three Tau boundaries:

- Cloudflare owns the deployed Worker, route, R2 assets, Durable Object state, DNS, and Access application.
- The Tau CLI or session host owns Nook credentials and authenticated management HTTP.
- A session execution environment owns any paths read or written by the `nook` agent tool.

`tau nook` CLI paths are local to the process running the command. Agent-tool paths belong to the session execution environment, even when the host is on another machine. Generated code never receives the Access secret, ambient filesystem, process environment, arbitrary network access, or `fetch`.

The `nook` config block can appear at global or project scope, and the most-specific complete object wins. A session picks it up on creation or `/reload`. CLI commands load the effective config for the command's startup working directory. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md) before operating Nook from an attached or hosted session.

## Set up the Cloudflare deployment

Before setup, prepare:

- a Cloudflare account and zone for the chosen hostname
- Wrangler installed on `PATH`
- `CLOUDFLARE_API_TOKEN` available for non-interactive Wrangler authentication
- npm and network access so Tau can prepare the bundled Worker package
- a Cloudflare Access self-hosted application design for the control plane

Run:

```sh
tau nook setup \
  --domain apps.example.net \
  --zone-name example.net \
  --access-team-domain https://engineering.cloudflareaccess.com \
  --access-aud 7f20d9d8c3a14f1fa8c3a5513b91d440
```

The command deploys the bundled Worker as `tau-nook`, creates or reuses the `tau-nook-assets` R2 bucket, and configures a route for `apps.example.net/*`. It writes the Access team domain and application audience into the Worker configuration so the Worker can validate Access identity.

The same inputs can come from `NOOK_DOMAIN`, `NOOK_ZONE_NAME`, `NOOK_ACCESS_TEAM_DOMAIN`, and `NOOK_ACCESS_AUD`. Explicit flags replace the corresponding environment values.

Setup does **not** create DNS records, an Access application, Access policies, or a service token. Complete those steps in Cloudflare after deployment.

## Configure the Access topology

Create one self-hosted Cloudflare Access application for exactly:

```text
https://apps.example.net/__nook/*
```

Do not protect the entire hostname. Public site assets must be able to reach the Worker anonymously, while management stays behind the control plane.

For that Access application:

1. Use the audience passed to `--access-aud`.
2. Disable the **Cookie Path Attribute**, allowing the Access cookie to apply to the hostname rather than only `/__nook/*`.
3. Add user Allow policies for people who may open private sites.
4. Add a Service Auth policy for a Cloudflare Access service token used by Tau.
5. Configure DNS for the chosen hostname and verify it routes to the Worker.

This topology has two distinct paths:

- `/__nook/*` is the Access-protected management and authentication control plane.
- `/<site>/*` is the site plane. Public sites are anonymous; private sites redirect browser navigation through `/__nook/auth` and then rely on the hostname-scoped Access identity.

Tau sends service-token headers only to pass Cloudflare Access. The Worker authorizes requests by validating the Access JWT, not by trusting those raw headers directly.

## Configure Tau

Create the Access service token, then add one Nook target to the effective Tau config:

```json
{
  "nook": {
    "domain": "apps.example.net",
    "accessClientId": "service-token-id.access",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  }
}
```

`domain` is required and must be a DNS hostname without a path, port, query, or fragment. The remaining fields are optional in the schema, but an Access-protected management plane normally requires both a client ID and a resolvable secret.

The secret resolves in this order:

1. a non-empty environment variable named by `accessClientSecretEnv`
2. inline `accessClientSecret`

There is no separate standard-variable override for ordinary Nook operations. `NOOK_ACCESS_CLIENT_SECRET` has special meaning only when the config names it, and as a destroy-command input described later. Keep the secret on the process performing the operation: the invoking CLI process for `tau nook`, or the session host for the agent tool. See [credentials](credentials.md).

Restart a CLI process after changing its environment. For a live session, run `/reload` while idle after changing the config visible from its execution-environment working directory.

## Deploy and inspect sites

Deploy a finished static directory:

```sh
tau nook deploy ./dist --site roadmap
tau nook list
```

CLI deployments are private by default. Add `--public` only when anonymous access, including anonymous browser KV writes, is intended:

```sh
tau nook deploy ./dist --site roadmap --public
```

Every successful deploy replaces the complete active asset set and sets visibility from that command. Omitting `--public` on the next deploy makes the site private again. Per-site KV survives either change.

Site slugs are 2 to 63 lowercase letters, digits, or hyphens, and must start and end with a letter or digit. Tau reserves `admin`, `api`, `assets`, `login`, `logout`, `nook`, `quick`, `static`, and `www`.

A site is served at `https://<domain>/<slug>/`. A request to `/<slug>` redirects to the trailing-slash URL. When an extensionless site path is absent, Nook serves root `index.html` as a single-page-app fallback; missing paths with file extensions return not found. Apps should use relative asset URLs or be built with a base path of `/<slug>/`.

To recover the active deployment files into a local working directory:

```sh
mkdir restored-roadmap
tau nook copy roadmap ./restored-roadmap
```

The destination must already exist and be empty. Tau downloads the complete active manifest and verifies file sizes and hashes before writing. Copy does not include the site's KV data.

Delete a site only when both its active assets and managed site state are no longer needed:

```sh
tau nook delete roadmap
```

Site deletion is destructive and Nook V0 has no rollback history.

## Artifact rules and limits

A deploy directory must contain root `index.html`. Tau walks the complete directory and rejects it if any path violates these rules:

- hidden files or directories are forbidden, including `.env`, `.git`, and `.DS_Store`
- symlinks are forbidden
- paths under `/__nook` are reserved
- traversal, absolute filesystem paths, null bytes, duplicate paths, and non-normalized paths are forbidden
- at most 1,000 files may be deployed
- each file may be at most 10 MiB
- total content may be at most 100 MiB
- each deployed path may be at most 512 characters

Tau chooses common content types from file extensions and uses `application/octet-stream` otherwise. Uploads are checked against their declared size and SHA-256 digest. Stable asset URLs require cache revalidation, so replacing a deployment does not rely on content-hashed URLs for freshness.

Nook does not apply ignore files. Build into a clean output directory rather than deploying a repository root. In particular, do not work around the hidden-file rejection by copying credentials into visible files.

## Templates

Templates are reusable directory snapshots in the configured Nook deployment. They are not sites, do not perform substitution, and do not run installs or builds.

```sh
tau nook template save vite-static ./starter
tau nook template list
mkdir next-app
tau nook template copy vite-static ./next-app
```

`save` creates or replaces the named template. `copy` requires an existing empty destination and verifies all downloaded files before writing. A template follows the same path, hidden-file, symlink, file-count, and byte limits as a deployment, but it does not require root `index.html`.

Template names use the same 2 to 63 character lowercase path-label format as site slugs. Site-reserved names are not reserved for templates.

Delete a template only when its stored editable snapshot is no longer needed:

```sh
tau nook template delete vite-static
```

Deleting a template does not delete sites that were built from it.

## Manage per-site KV

Nook KV is scoped to one site and stores JSON values. The CLI provides direct operations:

```sh
tau nook kv put roadmap settings '{"theme":"dark"}'
tau nook kv get roadmap settings
tau nook kv list roadmap --prefix releases/
tau nook kv delete roadmap settings
```

The `put` value must be valid JSON. Keys are 1 to 256 characters. Each value is limited to 64 KiB, and each site is limited to 1,000 keys and 5 MiB total JSON storage.

Browser applications use same-origin per-site KV. Public deployments expose both the static app and browser KV anonymously, which means the KV is **public-writable**. Do not store secrets, access tokens, private user data, or integrity-critical state in a public site's KV. Private deployments require a valid Cloudflare Access identity for site navigation and browser KV.

CLI and agent management operations use the Access-protected control plane rather than the browser route. The browser SDK contract and code examples belong to the deployment's version-matched Nook skill and are intentionally not duplicated here.

## Use the host tool

The assistant-facing `nook` tool appears only when both conditions hold:

- the current persona selects `nook`
- effective session configuration contains a valid `nook` block

The tool is host-owned. It performs authenticated Nook HTTP outside generated code and uses the session execution backend for deploy, copy, template, and file-backed KV paths. It should be invoked only for an explicit Nook, publishing, hosting, or Nook KV task.

The tool has two separate documentation stages:

1. Before using the management API, the built-in `docs` must be visible in the conversation context. If they are not, one documentation-only call prints and reads them. Do not reload them while they remain visible.
2. Before authoring or modifying a Nook app, a separate documentation-only call retrieves and prints `nook.skill()`. The agent reads that deployment-provided guide before writing files in later calls.

Do not combine skill retrieval with management operations, and do not guess either API from this page. The deployed skill owns browser SDK and app-authoring behavior so it stays version-matched to that Nook deployment. General tool eligibility and code-mode behavior are covered in [tools](tools.md).

## Verify a deployment

Verify from both management and browser perspectives:

1. Run `tau nook list` from a directory whose effective config contains the intended target.
2. Deploy a small nonsensitive private site with root `index.html`.
3. Open its trailing-slash URL in a browser and complete Access login.
4. Confirm that its assets resolve beneath the site path.
5. Exercise a disposable KV key through the app or CLI, then delete it.
6. If public access is required, redeploy with `--public` and test from a browser without an Access session.

A successful Worker deployment alone does not prove that DNS, Access cookie scope, user policy, service-token policy, or Tau credentials are correct.

## Common errors

**`nook is not configured`.** Add the `nook` block at a config level visible to the command or session. For an agent session, run `/reload` while idle or create a new session.

**A CLI command receives an Access login page or authorization error.** Confirm that Access protects only `/__nook/*`, the service token has a Service Auth policy, both token fields resolve in the invoking process, and the configured domain matches the deployed hostname.

**A private site repeatedly redirects or browser KV reports authentication required.** Disable the Access application's Cookie Path Attribute and confirm the user Allow policy and audience. The cookie must be valid across the hostname so the Worker can authorize `/<site>/*` after `/__nook/auth`.

**A public site still asks for Access.** The Access application probably covers the whole hostname rather than only `/__nook/*`, or the latest deploy omitted `--public` and made the site private again.

**Assets work at `/` during local development but fail after deploy.** Build for the `/<site>/` base path or use relative URLs. Nook does not rewrite arbitrary absolute asset references.

**Deploy rejects hidden files or symlinks.** Use a clean build output. Ignore files do not change Nook's manifest walk.

**Copy refuses the destination.** Create an empty directory first. Tau will not merge downloaded files into existing contents.

**The agent cannot see the tool.** Check both the persona's tool list and effective `nook` config. A config block alone does not override persona tool eligibility.

## Destroy the platform

Destroy removes platform data and infrastructure, not just one site. It first calls the authenticated cleanup endpoint to delete site Durable Object data and Nook R2 objects, then attempts to delete the `tau-nook` Worker and `tau-nook-assets` bucket.

Use environment variables for cleanup credentials so secrets do not enter shell history:

```sh
tau nook destroy --domain apps.example.net --yes
```

The command reads `NOOK_ACCESS_CLIENT_ID` and `NOOK_ACCESS_CLIENT_SECRET`; flags with the same names are also accepted but expose values more easily. It also accepts `NOOK_DOMAIN` instead of `--domain`, and requires `CLOUDFLARE_API_TOKEN` for Wrangler.

This operation is destructive. Confirm that all sites, templates, and KV are disposable or separately preserved before running it. If authenticated data cleanup fails, Tau stops before deleting infrastructure. Worker or bucket deletion failures are reported separately and can leave a partial deployment, so inspect every result line.

Destroy does not remove external DNS records, the Cloudflare Access application, its policies, or service tokens. Remove those separately after confirming the Nook hostname is no longer serving needed data, then remove obsolete Tau config and credentials.
