The one-shot JavaScript runtime provides these globals:

- `nook.skill()`: load the configured Nook deployment's version-matched app-authoring skill.
- `nook.sites`: list, copy, deploy, and delete sites.
- `nook.templates`: list, copy, save, and delete editable templates.
- `nook.kv`: get, put, import, export, delete, and list per-site JSON KV entries.
- `docs`: this agent-facing SDK document.
- `console`: program output. Only text written through console methods is returned; return values are ignored.

Top-level `await` is supported. Calls may run concurrently with `Promise.all`.

Use absolute file system paths. Generated code has no direct filesystem, process, environment, network, credential, import, timer, or `fetch` access. Nook methods are the only platform capability.

## App-authoring guidance

`docs` describes this agent-facing management SDK. `nook.skill()` is separate and returns the configured Nook deployment's app-authoring guide, including its browser SDK and KV contract.

When authoring or modifying a Nook app, print the skill before writing the app:

```js
console.log(await nook.skill());
```

## Sites

### `nook.sites.list()`

Return the configured target's sites as an array.

```js
const sites = await nook.sites.list();
for (const site of sites) {
  console.log(`${site.slug}: ${site.url} (${site.visibility ?? "not deployed"})`);
}
```

Each site may contain:

```js
{
  slug: string,
  url: string,
  createdAt?: string,
  updatedAt?: string,
  latestDeploymentId?: string,
  visibility?: "private" | "public",
  kv?: {
    keyCount: number,
    bytesUsed: number,
    maxKeys: number,
    maxBytes: number,
  },
}
```

### `nook.sites.copy(site, directory)`

Copy the active deployment into an existing empty directory. The site slug must be a valid non-reserved Nook slug. Files are downloaded and verified against the deployment manifest before any file is written.

```js
const copied = await nook.sites.copy("demo", "/tmp/demo-source");
console.log(`copied ${copied.fileCount} files to ${copied.directory}`);
```

The result contains `site`, `directory`, `deploymentId`, `visibility`, `fileCount`, and `byteCount`.

### `nook.sites.deploy(site, directory, options)`

Deploy a static directory as the site's new active deployment. `options.visibility` is required and must be `"private"` or `"public"`; visibility never defaults implicitly. The directory must contain a root `index.html` and satisfy Nook's path, file-count, and size limits.

```js
const deployed = await nook.sites.deploy("demo", "/tmp/demo-dist", {
  visibility: "private",
});
console.log(`deployed ${deployed.url} as ${deployed.visibility}`);
```

The result contains `site`, `url`, `visibility`, `deploymentId`, `fileCount`, and `byteCount`.

Build app artifacts before deploying. When creating a new app, put the complete working tree under a fresh temporary directory rather than scattering files into the project, then deploy its built static output directory.

### `nook.sites.delete(site)`

Delete a site and its managed state.

```js
const deleted = await nook.sites.delete("demo");
console.log(`deleted ${deleted.site}: ${deleted.deleted}`);
```

## Templates

### `nook.templates.list()`

Return templates as an array.

```js
const templates = await nook.templates.list();
for (const template of templates) {
  console.log(`${template.name}: ${template.fileCount} files, revision ${template.revisionId}`);
}
```

Each template contains `name`, `revisionId`, `createdAt`, `updatedAt`, `fileCount`, and `byteCount`.

### `nook.templates.copy(name, directory)`

Copy a verified template revision into an existing empty directory.

```js
const copied = await nook.templates.copy("starter", "/tmp/new-app");
console.log(`copied ${copied.name} to ${copied.directory}`);
```

The result contains the template summary fields plus `directory`.

### `nook.templates.save(name, directory)`

Save a directory as the template's new active revision. Templates use the same path, file-count, and size validation as deployments but do not require `index.html`.

```js
const saved = await nook.templates.save("starter", "/tmp/app-source");
console.log(`saved ${saved.name} revision ${saved.revisionId}`);
```

### `nook.templates.delete(name)`

Delete a template.

```js
const deleted = await nook.templates.delete("starter");
console.log(`deleted ${deleted.template}: ${deleted.deleted}`);
```

## Per-site KV

KV values must be JSON-serializable. Keys must contain 1-256 characters.

### `nook.kv.get(site, key)`

Return the stored JSON value directly.

```js
const settings = await nook.kv.get("demo", "settings");
console.log(`theme: ${settings.theme}`);
```

### `nook.kv.getToFile(site, key, file)`

Write the stored JSON value to a file in the session execution environment. Parent directories are created as needed. Return `{ site, key, file, bytes }`.

```js
const saved = await nook.kv.getToFile("demo", "settings", "/tmp/settings.json");
console.log(`wrote ${saved.bytes} bytes to ${saved.file}`);
```

### `nook.kv.put(site, key, value)`

Store a JSON value and return `{ site, key }`.

```js
const stored = await nook.kv.put("demo", "settings", { theme: "dark" });
console.log(`stored ${stored.site}/${stored.key}`);
```

### `nook.kv.putFromFile(site, key, file)`

Parse a JSON file from the session execution environment, store its value, and return `{ site, key, file }`. Files are limited to the 64 KiB maximum size of a KV value.

```js
const stored = await nook.kv.putFromFile("demo", "settings", "/tmp/settings.json");
console.log(`stored ${stored.site}/${stored.key} from ${stored.file}`);
```

### `nook.kv.delete(site, key)`

Delete a value and return `{ site, key, deleted }`.

```js
const deleted = await nook.kv.delete("demo", "settings");
console.log(`deleted: ${deleted.deleted}`);
```

### `nook.kv.list(site, options?)`

Return matching key metadata as an array. `options.prefix` optionally filters keys.

```js
const keys = await nook.kv.list("demo", { prefix: "todos/" });
for (const entry of keys) {
  console.log(`${entry.key}: ${entry.sizeBytes} bytes, updated ${entry.updatedAt}`);
}
```

Each entry contains `key`, `sizeBytes`, and `updatedAt`.

## Common patterns

List sites and templates concurrently:

```js
const [sites, templates] = await Promise.all([
  nook.sites.list(),
  nook.templates.list(),
]);
console.log(`sites: ${sites.map((site) => site.slug).join(", ") || "none"}`);
console.log(`templates: ${templates.map((template) => template.name).join(", ") || "none"}`);
```

Copy, inspect or modify with filesystem tools in later calls, build with Bash, then deploy the built directory in a later Nook call. Do not deploy an editable source directory unless it is already the complete static artifact.

## Output guidance

Print only information needed for the task. Prefer concise labeled text over serialized response objects. Select relevant fields when possible; when all fields matter, flatten and label them compactly. Emit JSON only when the user explicitly requests JSON or another machine-readable result.
