# Nook

Nook is Tau's optional platform for publishing small static apps, each at its own path under one hostname. Each site has its built front-end files and its own JSON KV store. Tau deploys and manages sites with its own authenticated client.

Nook V0 is deliberately small. It hosts static files on Cloudflare only and does not run applications. Build an app before deploying it. Nook does not run server code for a site, set up custom domains per app, keep a rollback history, or build a source repository for you.

## V0 at a glance

A Nook deployment has one configured hostname and many sites:

```text
https://apps.example.net/roadmap/
https://apps.example.net/release-notes/
```

Each site has one active deployment of static files, a visibility of `private` or `public`, and its own JSON KV store that survives redeploys. Templates are stored copies of editable directories. You can copy one into a working directory, change and build it with your usual tools, and then deploy it.

V0 has no dashboards, subdomain site URLs, deploy rollback, audit logs, ownership roles, realtime APIs, AI proxy APIs, ignore files, or support for providers other than Cloudflare. `.gitignore` and `.nookignore` have no effect, so the deploy directory must contain only the files you mean to publish.

## Ownership and apply boundaries

Nook involves three parties:

- Cloudflare runs the deployed Worker and holds its route, R2 files, Durable Object state, DNS, and Access application.
- The Tau CLI, or the session host, holds the Nook credentials and makes the authenticated management requests.
- The session's execution environment holds the files that the `tau.nook` capability reads or writes.

Paths given to the `tau nook` CLI are on the machine running the command. Paths used by the agent are in the session's execution environment, even when the host is on another machine. The model's code never receives the Access secret, files, environment variables, network access, or `fetch`.

The `nook` config block can be set at global or project level, and the most specific complete object wins. A session reads it when created and on `/reload`. CLI commands read the configuration for the directory they are started in. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md) before operating Nook from an attached or hosted session.

## Set up the Cloudflare deployment

Before setup, prepare:

- a Cloudflare account and zone for the chosen hostname
- Wrangler installed on `PATH`
- `CLOUDFLARE_API_TOKEN` available, so Wrangler authenticates without prompts
- npm and network access, so Tau can prepare the Worker package it ships
- a plan for a Cloudflare Access self-hosted application that protects the control plane

Run:

```sh
tau nook setup \
  --domain apps.example.net \
  --zone-name example.net \
  --access-team-domain https://engineering.cloudflareaccess.com \
  --access-aud 7f20d9d8c3a14f1fa8c3a5513b91d440
```

The command deploys the Worker as `tau-nook`, creates or reuses the `tau-nook-assets` R2 bucket, and adds a route for `apps.example.net/*`. It writes the Access team domain and application audience into the Worker's configuration so the Worker can validate Access identities.

The same values can come from `NOOK_DOMAIN`, `NOOK_ZONE_NAME`, `NOOK_ACCESS_TEAM_DOMAIN`, and `NOOK_ACCESS_AUD`. Flags win over these variables.

Setup does **not** create DNS records, an Access application, Access policies, or a service token. Complete those steps in Cloudflare after deployment.

## Configure the Access topology

Create one self-hosted Cloudflare Access application for exactly:

```text
https://apps.example.net/__nook/*
```

Do not protect the whole hostname. Requests for public sites must reach the Worker without signing in, while management stays behind Access.

For that Access application:

1. Use the audience passed to `--access-aud`.
2. Disable the **Cookie Path Attribute**, so the Access cookie applies to the whole hostname and not only to `/__nook/*`.
3. Add user Allow policies for people who may open private sites.
4. Add a Service Auth policy for a Cloudflare Access service token used by Tau.
5. Configure DNS for the chosen hostname and verify it routes to the Worker.

This gives two kinds of paths:

- `/__nook/*` is the control plane for management and sign-in, protected by Access.
- `/<site>/*` serves the sites. Public sites need no sign-in. A browser opening a private site is sent through `/__nook/auth` to sign in, and then uses the Access identity that is valid for the whole hostname.

Tau sends service-token headers only to get past Cloudflare Access. The Worker decides what a request may do by validating the Access JWT, never by trusting those headers.

## Configure Tau

Create the Access service token, then add one Nook target to your Tau config:

```json
{
  "nook": {
    "domain": "apps.example.net",
    "accessClientId": "service-token-id.access",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  }
}
```

`domain` is required and must be a DNS hostname without a path, port, query, or fragment. The other fields are optional in the schema, but because the control plane is behind Access you normally need both a client ID and a secret.

The secret resolves in this order:

1. a non-empty environment variable named by `accessClientSecretEnv`
2. inline `accessClientSecret`

No fixed environment variable overrides these for ordinary Nook operations. `NOOK_ACCESS_CLIENT_SECRET` is used only when the config names it, and by the destroy command described below. Keep the secret on the process that performs the operation: the CLI process for `tau nook`, or the session host for the agent's capability. See [credentials](credentials.md).

A new CLI command picks up environment changes. For a running session, run `/reload` while idle after changing the config that applies to its working directory.

## Deploy and inspect sites

Deploy a finished static directory:

```sh
tau nook deploy ./dist --site roadmap
tau nook list
```

CLI deployments are private by default. Add `--public` only when anyone should be able to open the site, which also lets anyone write its browser KV:

```sh
tau nook deploy ./dist --site roadmap --public
```

Every successful deploy replaces all of the site's files and sets its visibility from that command. Leaving out `--public` on the next deploy makes the site private again. The site's KV survives either change.

Site slugs are 2 to 63 lowercase letters, digits, or hyphens, and must start and end with a letter or digit. Tau reserves `admin`, `api`, `assets`, `login`, `logout`, `nook`, `quick`, `static`, and `www`.

A site is served at `https://<domain>/<slug>/`, and `/<slug>` redirects to that URL. For a missing path without a file extension, Nook serves the root `index.html`, so single-page apps work. A missing path with a file extension returns not found. Use relative asset URLs, or build the app with the base path `/<slug>/`.

To download a site's current files into a local directory:

```sh
mkdir restored-roadmap
tau nook copy roadmap ./restored-roadmap
```

The destination must already exist and be empty. Tau downloads every file and checks sizes and hashes before writing. The site's KV data is not included.

Delete a site only when you no longer need its files or its stored state:

```sh
tau nook delete roadmap
```

Deleting a site cannot be undone, and V0 keeps no earlier versions.

## Artifact rules and limits

A deploy directory must contain `index.html` at its root. Tau checks every path in the directory and rejects the deploy if any breaks these rules:

- hidden files or directories are forbidden, including `.env`, `.git`, and `.DS_Store`
- symlinks are forbidden
- paths under `/__nook` are reserved
- traversal, absolute filesystem paths, null bytes, duplicate paths, and non-normalized paths are forbidden
- at most 1,000 files may be deployed
- each file may be at most 10 MiB
- total content may be at most 100 MiB
- each deployed path may be at most 512 characters

Tau sets common content types from file extensions and uses `application/octet-stream` for the rest. Each upload is checked against its declared size and SHA-256 digest. Browsers must revalidate cached files, so a new deployment shows up even when file names do not contain content hashes.

Nook ignores ignore files. Build into a clean output directory instead of deploying a repository root. Never work around the hidden-file rule by copying credentials into files without a leading dot.

## Templates

Templates are reusable directory copies stored in your Nook deployment. They are not sites. Tau does not fill in placeholders or run installs or builds for them.

```sh
tau nook template save vite-static ./starter
tau nook template list
mkdir next-app
tau nook template copy vite-static ./next-app
```

`save` creates or replaces the named template. `copy` needs an existing empty destination and checks all downloaded files before writing. Templates follow the same rules and limits as deployments for paths, hidden files, symlinks, file count, and size, but do not need a root `index.html`.

Template names follow the same format as site slugs. The names reserved for sites are allowed for templates.

Delete a template only when you no longer need it:

```sh
tau nook template delete vite-static
```

Deleting a template does not delete sites that were built from it.

## Manage per-site KV

Each site has its own KV store of JSON values. The CLI can read and change it directly:

```sh
tau nook kv put roadmap settings '{"theme":"dark"}'
tau nook kv get roadmap settings
tau nook kv list roadmap --prefix releases/
tau nook kv delete roadmap settings
```

The `put` value must be valid JSON. Keys are 1 to 256 characters. Each value is limited to 64 KiB, and each site is limited to 1,000 keys and 5 MiB total JSON storage.

Apps in the browser use their site's KV from the same origin. On a public site, anyone can open the app and use its KV, so the KV is **writable by anyone**. Never store secrets, access tokens, private user data, or data whose integrity matters in a public site's KV. A private site requires a valid Cloudflare Access identity both to open the site and to use its KV.

The CLI and the agent manage KV through the control plane behind Access, not through the browser path. The browser API and its examples are documented in the Nook skill that each deployment provides, so they match that deployment's version.

## Use the agent capability

The `tau.nook` capability in the agent's `code` tool is available only when:

- the current persona selects `nook`, and
- the session's configuration contains a valid `nook` block.

The host makes the authenticated Nook requests, outside the model's code. Files for deploys, copies, templates, and KV come from the session's execution environment. The agent uses the capability only when asked to work with Nook, publish or host a site, or manage Nook KV.

The agent reads documentation in two separate steps:

1. Before using the management API, it reads the built-in `docs`. If it has not seen them, its first call only prints them, and later calls use the API. Documentation already in the conversation is reused.
2. Before writing an app, it makes a separate call that only prints `nook.skill()`, the authoring guide that the deployment provides, and reads it before writing files.

This page does not describe either API. The deployed skill covers the browser API and app authoring, so it always matches that deployment's version. General tool eligibility and code-mode behavior are covered in [tools](tools.md).

## Verify a deployment

Check both management and the browser:

1. Run `tau nook list` from a directory whose config contains the intended target.
2. Deploy a small private site with a root `index.html` and nothing sensitive in it.
3. Open its trailing-slash URL in a browser and complete Access login.
4. Confirm that its assets resolve beneath the site path.
5. Write a throwaway KV key through the app or the CLI, then delete it.
6. If public access is required, redeploy with `--public` and test from a browser without an Access session.

A successful Worker deployment does not prove that DNS, the Access cookie scope, user policies, the service token policy, or Tau's credentials are right.

## Common errors

**`nook is not configured`.** Add the `nook` block at a config level that applies to the command or session. For an agent session, run `/reload` while idle or create a new session.

**A CLI command gets an Access login page or an authorization error.** Confirm that Access protects only `/__nook/*`, the service token has a Service Auth policy, both token fields are available to the process running the command, the configured domain matches the deployed hostname, and the Worker was set up with the right Access team domain and audience.

**A private site keeps redirecting, or browser KV says authentication is required.** Disable the Access application's Cookie Path Attribute, and check the user Allow policy and the audience. The cookie must be valid for the whole hostname so the Worker can accept `/<site>/*` requests after `/__nook/auth`.

**A public site still asks for Access.** The Access application probably covers the whole hostname instead of only `/__nook/*`, or the latest deploy left out `--public` and made the site private again.

**Files load at `/` during local development but fail after deploy.** Build for the `/<site>/` base path or use relative URLs. Nook does not rewrite absolute asset URLs.

**Deploy rejects hidden files or symlinks.** Use a clean build output. Ignore files have no effect on what Nook deploys.

**Copy refuses the destination.** Create an empty directory first. Tau never merges downloaded files into existing content.

**The agent does not have the capability.** Check both the persona's tools and the `nook` config in the session's execution environment, then `/reload` while idle and start a new turn. The config block alone is not enough if the persona does not select `nook`. Subagents get Nook only when the main persona has it.

**The CLI works but the agent does not, or the other way around.** The CLI uses the configuration and credentials of the machine running it, and the agent's capability uses the session's configuration and the host's credentials. Start with `tau nook --help` and `tau nook list`, which shows URLs and visibility without printing secrets.

**A site has the wrong visibility.** Check it with `tau nook list`, then redeploy reviewed content with or without `--public`. If something sensitive was public, rotate exposed credentials right away and remove sensitive KV entries with `tau nook kv delete`, because KV survives redeploys. Use `tau nook delete` only when you mean to take the site offline.

**Setup or destroy fails before reaching Cloudflare.** Both need Wrangler on `PATH` and `CLOUDFLARE_API_TOKEN`, so Wrangler can sign in without prompts. Compare this page and `tau nook --help` with the deployed Worker's version before upgrading or changing infrastructure.

## Destroy the platform

Destroy removes all Nook data and infrastructure, not just one site. It first calls the authenticated cleanup endpoint to delete every site's Durable Object data and Nook's R2 objects, then tries to delete the `tau-nook` Worker and the `tau-nook-assets` bucket.

Pass the cleanup credentials as environment variables, so the secrets stay out of shell history:

```sh
tau nook destroy --domain apps.example.net --yes
```

The command reads `NOOK_ACCESS_CLIENT_ID` and `NOOK_ACCESS_CLIENT_SECRET`. Flags with the same names also work, but expose the values more easily. It accepts `NOOK_DOMAIN` instead of `--domain`, and needs `CLOUDFLARE_API_TOKEN` for Wrangler.

This deletes data permanently. Before running it, make sure every site, template, and KV store is either disposable or saved elsewhere. If the data cleanup fails, Tau stops before deleting any infrastructure. Worker and bucket deletion failures are reported separately and can leave a partial deployment, so read every result line.

Destroy does not remove DNS records, the Cloudflare Access application, its policies, or service tokens. Remove those yourself once the Nook hostname no longer serves anything you need, then remove the Tau config and credentials you no longer use.
