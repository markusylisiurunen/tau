# tau.nook

Manage static sites, reusable source templates, and per-site JSON KV on the configured Nook deployment. Use absolute paths for file and directory arguments; these refer to files on your machine.

## Interface

```ts
type NookApi = {
  skill(): Promise<string>;
  sites: SitesApi;
  templates: TemplatesApi;
  kv: KvApi;
};
```

## `tau.nook.skill()`

Takes no arguments and returns the app-authoring guide as a string, including the browser SDK and KV contract. When authoring or modifying an app, retrieve it in a separate documentation-only call and read it before subsequent work:

```js
printText(await tau.nook.skill());
```

Do not combine this retrieval with management operations. Reuse a guide already visible in the conversation. This reference describes management methods, not the API available inside a hosted app.

## Sites

```ts
type Visibility = "private" | "public";
type Site = {
  slug: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  latestDeploymentId?: string;
  visibility?: Visibility;
  kv?: { keyCount: number; bytesUsed: number; maxKeys: number; maxBytes: number };
};
type Deployment = {
  site: string;
  url: string;
  visibility: Visibility;
  deploymentId: string;
  fileCount: number;
  byteCount: number;
};
type SiteCopy = Omit<Deployment, "url"> & { directory: string };

type SitesApi = {
  list(): Promise<Site[]>;
  copy(site: string, directory: string): Promise<SiteCopy>;
  deploy(site: string, directory: string, options: { visibility: Visibility }): Promise<Deployment>;
  delete(site: string): Promise<{ site: string; deleted: boolean }>;
};
```

These methods are called on `tau.nook.sites`:

- `list()`: list site summaries. Deployment and KV metadata may be absent for an undeployed site.
- `copy(site, directory)`: copy the active deployment into an existing empty directory. Downloads are verified against the manifest before writing. Interruption during file writes can leave a partial destination; inspect it before retrying.
- `deploy(site, directory, { visibility })`: publish the directory as the new active deployment, creating the site if needed. Visibility is required, never implicit. KV survives redeploys. The result's `url` is the link to return to the user.
- `delete(site)`: delete the site and its managed state. This is destructive; `deleted` reports whether anything was deleted.

Site slugs are 2–63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit. Reserved slugs are `admin`, `api`, `assets`, `login`, `logout`, `nook`, `quick`, `static`, and `www`.

Deploy built static output, not an editable source tree unless it is already the complete artifact. A deployment requires root `index.html`. Limits: 1,000 files, 10 MiB per file, 100 MiB total, paths up to 512 characters. Hidden paths, symlinks, traversal, and `/__nook` or its descendants are rejected. Build relative asset URLs or use the site's `/<slug>/` base path.

```js
const deployed = await tau.nook.sites.deploy("demo", "/absolute/path/to/built-app", {
  visibility: "private",
});
printText(`${deployed.url} (${deployed.visibility})`);
```

Replace the example directory with the absolute path of an existing built artifact. Nook uploads files; it does not run a build command.

## Templates

Templates are reusable editable directory snapshots, separate from deployed sites.

```ts
type Template = {
  name: string;
  revisionId: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  byteCount: number;
};
type TemplatesApi = {
  list(): Promise<Template[]>;
  copy(name: string, directory: string): Promise<Template & { directory: string }>;
  save(name: string, directory: string): Promise<Template>;
  delete(name: string): Promise<{ template: string; deleted: boolean }>;
};
```

These methods are called on `tau.nook.templates`:

- `list()`: discover available templates and revisions.
- `copy(name, directory)`: copy a verified revision into an existing empty directory. The result includes its summary and the destination.
- `save(name, directory)`: save the directory as the template's new active revision. File/path limits match deployments, but `index.html` is not required.
- `delete(name)`: delete a template, not sites built from it.

Template names follow the same 2–63-character format as site slugs, without the site reserved-name list. A copied template is a source snapshot, not necessarily a built static artifact. Saving a template does not deploy it.

## Per-site KV

Values are JSON, not files or arbitrary JavaScript objects. Keys are 1–256 characters, each encoded value is at most 64 KiB, and each site permits up to 1,000 keys and 5 MiB total storage.

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type KvEntry = { key: string; sizeBytes: number; updatedAt: string };
type KvApi = {
  get(site: string, key: string): Promise<Json>;
  getToFile(site: string, key: string, file: string): Promise<{
    site: string; key: string; file: string; bytes: number;
  }>;
  put(site: string, key: string, value: Json): Promise<{ site: string; key: string }>;
  putFromFile(site: string, key: string, file: string): Promise<{
    site: string; key: string; file: string;
  }>;
  delete(site: string, key: string): Promise<{ site: string; key: string; deleted: boolean }>;
  list(site: string, options?: { prefix?: string }): Promise<KvEntry[]>;
};
```

These methods are called on `tau.nook.kv`:

- `get`: returns the stored value directly, not an envelope. Missing keys return `null`, indistinguishable from a stored JSON null; use `list` when existence matters. Inspect the value before accessing fields.
- `getToFile`: writes JSON to the specified file, creating parent directories as needed. It may overwrite an existing file.
- `put`: stores or replaces one key's JSON value.
- `putFromFile`: parses UTF-8 JSON from a file of at most 64 KiB and stores its value.
- `delete`: removes one key; check `deleted` if existence matters.
- `list`: returns key metadata, not values; optional `prefix` restricts matching keys. There is no pagination argument.

```js
const keys = await tau.nook.kv.list("demo", { prefix: "todos/" });
for (const entry of keys) printText(`${entry.key}: ${entry.sizeBytes} bytes`);
```

## Limits and failures

Invalid arguments, failed requests, invalid artifacts, and exceeded quotas throw. Mutations and local file writes are not rolled back when a program fails or is interrupted. Inspect current site, template, KV, or file state before retrying an uncertain mutation.
