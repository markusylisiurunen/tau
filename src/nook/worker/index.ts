import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

type Env = {
  ASSETS: R2Bucket;
  REGISTRY_DO: DurableObjectNamespace;
  SITE_DO: DurableObjectNamespace;
  NOOK_DOMAIN: string;
  NOOK_ACCESS_TEAM_DOMAIN: string;
  NOOK_ACCESS_AUD: string;
};

type R2Bucket = {
  get(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult>;
};

type R2Object = {
  body: ReadableStream | null;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
};

type R2ListResult = {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
};

type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

type DurableObjectId = unknown;

type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectState = {
  storage: DurableObjectStorage;
};

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type DurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
};

type Identity = {
  actor: string;
};

type ManifestFile = {
  path: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
};

type DeploymentRecord = {
  deploymentId: string;
  status: "pending" | "active";
  public: boolean;
  createdAt: string;
  finishedAt?: string;
  token: string;
  expiresAt: string;
  files: ManifestFile[];
  uploaded: string[];
};

type SiteSummary = {
  slug: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  latestDeploymentId?: string;
  visibility?: "public" | "private";
};

type TemplateSummary = {
  name: string;
  revisionId: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  byteCount: number;
};

type TemplateSaveRecord = {
  saveId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  files: ManifestFile[];
  uploaded: string[];
};

type SiteState = {
  activeDeploymentId?: string;
  activePublic?: boolean;
  createdAt: string;
  updatedAt: string;
};

type KvRecord = {
  value: unknown;
  sizeBytes: number;
  updatedAt: string;
  updatedBy: string;
};

type HtmlRewriterContentOptions = {
  html?: boolean;
};

type HtmlRewriterEndTag = {
  before(content: string, options?: HtmlRewriterContentOptions): void;
};

type HtmlRewriterElement = {
  prepend(content: string, options?: HtmlRewriterContentOptions): void;
  onEndTag(handler: (endTag: HtmlRewriterEndTag) => void): void;
};

type HtmlRewriterDocumentEnd = {
  append(content: string, options?: HtmlRewriterContentOptions): void;
};

type HtmlRewriterHandler = {
  element?(element: HtmlRewriterElement): void;
  end?(end: HtmlRewriterDocumentEnd): void;
};

type HtmlRewriterRuntime = {
  on(selector: string, handler: HtmlRewriterHandler): HtmlRewriterRuntime;
  onDocument(handler: HtmlRewriterHandler): HtmlRewriterRuntime;
  transform(response: Response): Response;
};

declare const HTMLRewriter: {
  new (): HtmlRewriterRuntime;
};

const RESERVED_PREFIX = "/__nook";
const DEPLOY_SESSION_MS = 15 * 60 * 1000;
const TEMPLATE_SAVE_SESSION_MS = 15 * 60 * 1000;
const MAX_PENDING_DEPLOYMENTS = 3;
const MAX_PENDING_TEMPLATE_SAVES = 3;
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_KV_KEY_LENGTH = 256;
const MAX_KV_VALUE_BYTES = 64 * 1024;
const MAX_KV_KEYS = 1_000;
const MAX_KV_TOTAL_BYTES = 5 * 1024 * 1024;
const DEPLOYED_ASSET_CACHE_CONTROL = "public, no-cache, must-revalidate";
const RESERVED_SITE_SLUGS = new Set([
  "admin",
  "api",
  "assets",
  "login",
  "logout",
  "nook",
  "quick",
  "static",
  "www",
]);

const accessJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const SKILL_MARKDOWN = `# Nook

Nook deploys static mini-apps to path-based site URLs and gives each site same-origin JSON KV through window.nook. It also stores editable templates that can be copied to a working directory, modified, built, and deployed separately.

Deploy a finished static directory only. The directory must contain /index.html, must not contain hidden files or symlinks, and must not contain files under /__nook/. Templates follow the same file safety rules but do not require /index.html. Copying a template requires an existing empty destination directory.

Sites are served at https://<nook-domain>/<site>/.

The Worker injects /<site>/__nook/client.js just after the opening HTML body tag.

Code that runs from the document head should wait until DOMContentLoaded, or otherwise run after the page has loaded, before using window.nook:

\`\`\`js
window.addEventListener("DOMContentLoaded", async () => {
  await window.nook.kv.put("settings", { theme: "dark" });
  const settings = await window.nook.kv.get("settings");
  await window.nook.kv.delete("settings");
  const keys = await window.nook.kv.list({ prefix: "todos/" });
});
\`\`\`

KV is per-site, JSON-only, and survives redeploys. Public deployments expose public writable per-site KV. Private deployments require Cloudflare Access identity.
`;

const CLIENT_JS = `(() => {
  const script = document.currentScript;
  const scriptUrl = script && script.src
    ? new URL(script.src)
    : new URL("/__nook/client.js", window.location.origin);
  const basePath = scriptUrl.pathname.replace(/\\/__nook\\/client\\.js$/, "");
  function apiPath(path) {
    return basePath + path;
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const payload = await response.json();
        message = payload && payload.error && payload.error.message ? payload.error.message : message;
      } catch {}
      throw new Error(message);
    }
    if (response.status === 204) return null;
    return await response.json();
  }
  window.nook = {
    kv: {
      async get(key) {
        const payload = await request(apiPath("/__nook/kv/" + encodeURIComponent(key)));
        return payload.value;
      },
      async put(key, value) {
        await request(apiPath("/__nook/kv/" + encodeURIComponent(key)), {
          method: "PUT",
          body: JSON.stringify(value)
        });
      },
      async delete(key) {
        await request(apiPath("/__nook/kv/" + encodeURIComponent(key)), { method: "DELETE" });
      },
      async list(options = {}) {
        const url = new URL(apiPath("/__nook/kv"), window.location.origin);
        if (options.prefix) url.searchParams.set("prefix", options.prefix);
        const payload = await request(url.pathname + url.search);
        return payload.keys;
      }
    }
  };
})();`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function now(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function accessTokenFromRequest(request: Request): string | undefined {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  if (headerToken?.trim()) return headerToken.trim();
  const cookie = request.headers.get("Cookie") ?? "";
  for (const segment of cookie.split(";")) {
    const [name, ...rest] = segment.trim().split("=");
    if (name === "CF_Authorization") return rest.join("=");
  }
  return undefined;
}

function accessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = accessJwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    accessJwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

function stringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === "string" && value ? value : undefined;
}

function accessActor(payload: JWTPayload): string {
  return (
    stringClaim(payload, "email") ??
    stringClaim(payload, "common_name") ??
    payload.sub ??
    "access-user"
  );
}

async function verifyAccessJwt(token: string, env: Env): Promise<Identity> {
  const teamDomain = env.NOOK_ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  const audience = env.NOOK_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) {
    throw new ErrorResponse("access_not_configured", "Cloudflare Access is not configured", 500);
  }

  try {
    const { payload } = await jwtVerify(token, accessJwks(teamDomain), {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
    });
    if (!payload.exp) {
      throw new ErrorResponse("unauthorized", "Cloudflare Access JWT has invalid claims", 401);
    }
    return { actor: accessActor(payload) };
  } catch (err) {
    if (err instanceof ErrorResponse) throw err;
    throw new ErrorResponse("unauthorized", "Invalid Cloudflare Access JWT", 401);
  }
}

async function requireAccessIdentity(request: Request, env: Env): Promise<Identity> {
  const token = accessTokenFromRequest(request);
  if (!token) throw new ErrorResponse("unauthorized", "Authentication required", 401);
  return await verifyAccessJwt(token, env);
}

async function optionalAccessIdentity(request: Request, env: Env): Promise<Identity> {
  const token = accessTokenFromRequest(request);
  if (!token) return { actor: "anonymous" };
  try {
    return await verifyAccessJwt(token, env);
  } catch {
    return { actor: "anonymous" };
  }
}

function validatePathLabel(value: string, label: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(value)) return `invalid ${label}`;
  return undefined;
}

function validateSlug(slug: string): string | undefined {
  return (
    validatePathLabel(slug, "slug") ?? (RESERVED_SITE_SLUGS.has(slug) ? "reserved slug" : undefined)
  );
}

function validateTemplateName(name: string): string | undefined {
  return validatePathLabel(name, "template name");
}

function normalizeAssetPath(pathname: string): string | undefined {
  if (
    !pathname ||
    pathname.includes("\0") ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//")
  ) {
    return undefined;
  }
  const parts = pathname.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") return undefined;
    out.push(part);
  }
  const normalized = `/${out.join("/")}`;
  if (normalized === RESERVED_PREFIX || normalized.startsWith(`${RESERVED_PREFIX}/`))
    return undefined;
  if (normalized.length > MAX_PATH_LENGTH) return undefined;
  return normalized;
}

function validateManifest(
  files: ManifestFile[],
  options: { requireIndex: boolean; artifactLabel: string },
): string | undefined {
  const label = options.artifactLabel;
  if (!Array.isArray(files) || files.length === 0) return "manifest must include files";
  if (files.length > MAX_FILES) return `${label} exceeds ${MAX_FILES} files`;
  const paths = new Set<string>();
  let total = 0;
  let hasIndex = false;
  for (const file of files) {
    const normalized = normalizeAssetPath(file.path);
    if (!normalized || normalized !== file.path) return `invalid asset path ${file.path}`;
    if (paths.has(file.path)) return `duplicate asset path ${file.path}`;
    if (file.path.split("/").some((segment) => segment.startsWith("."))) {
      return `hidden deploy path ${file.path} is not allowed`;
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      return `invalid sha256 for ${file.path}`;
    }
    paths.add(file.path);
    if (file.path === "/index.html") hasIndex = true;
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes < 0)
      return `invalid size for ${file.path}`;
    if (file.sizeBytes > MAX_FILE_BYTES) return `${file.path} exceeds max file size`;
    total += file.sizeBytes;
    if (typeof file.contentType !== "string" || !file.contentType)
      return `invalid content type for ${file.path}`;
  }
  if (options.requireIndex && !hasIndex) return "root index.html is required";
  if (total > MAX_TOTAL_BYTES) return `${label} exceeds max total size`;
  return undefined;
}

function parseHost(url: URL, env: Env): { kind: "base" } | undefined {
  const domain = env.NOOK_DOMAIN.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === domain) return { kind: "base" };
  return undefined;
}

type SitePath = {
  slug: string;
  sitePath: string;
  needsSlashRedirect: boolean;
};

function parseSitePath(pathname: string): SitePath | undefined {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) return undefined;

  let slug: string;
  try {
    slug = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  const slugError = validateSlug(slug);
  if (slugError) return undefined;

  const rest = match[2];
  return {
    slug,
    sitePath: rest && rest !== "/" ? rest : "/index.html",
    needsSlashRedirect: rest === undefined,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ErrorResponse("invalid_json", "Invalid JSON body", 400);
  }
}

async function registryFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return await env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("__nook_registry")).fetch(
    new Request(`https://registry.local${path}`, init),
  );
}

async function siteFetch(
  env: Env,
  site: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return await env.SITE_DO.get(env.SITE_DO.idFromName(site)).fetch(
    new Request(`https://site.local${path}`, init),
  );
}

function assetKey(site: string, deploymentId: string, path: string): string {
  return `sites/${site}/deployments/${deploymentId}${path}`;
}

function templateRevisionPrefix(name: string, revisionId: string): string {
  return `templates/${name}/revisions/${revisionId}/`;
}

function templateFileKey(name: string, revisionId: string, path: string): string {
  return `${templateRevisionPrefix(name, revisionId)}${path.replace(/^\/+/, "")}`;
}

function siteUrl(domain: string, site: string): string {
  return `https://${domain}/${site}/`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
      deleted += listed.objects.length;
    }
    cursor = listed.cursor;
    if (!listed.truncated) break;
  } while (cursor);
  return deleted;
}

async function handleTemplateApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: WorkerExecutionContext,
): Promise<Response> {
  const match = url.pathname.match(
    /^\/__nook\/api\/templates(?:\/([^/]+))?(?:\/save\/([^/]+)\/(file|finish)|\/save\/start|\/file)?$/,
  );
  if (!match) return error("not_found", "Unknown Nook API route", 404);

  const name = match[1] ? decodeURIComponent(match[1]) : undefined;
  const saveId = match[2] ? decodeURIComponent(match[2]) : undefined;
  const saveAction = match[3];

  if (url.pathname === "/__nook/api/templates" && request.method === "GET") {
    return await registryFetch(env, "/templates");
  }

  if (!name) return error("template_not_found", "Template is required", 404);
  const nameError = validateTemplateName(name);
  if (nameError) return error("invalid_template", nameError, 400);

  if (request.method === "GET" && url.pathname === `/__nook/api/templates/${name}`) {
    return await registryFetch(env, `/templates/${encodeURIComponent(name)}/manifest`);
  }

  if (request.method === "GET" && url.pathname === `/__nook/api/templates/${name}/file`) {
    const revisionId = url.searchParams.get("revision");
    if (!revisionId || !/^tpl_[a-f0-9]{24}$/.test(revisionId)) {
      return error("invalid_revision", "Invalid template revision", 400);
    }
    const path = url.searchParams.get("path");
    const normalized = path ? normalizeAssetPath(path) : undefined;
    if (!normalized || normalized !== path)
      return error("invalid_path", "Invalid template file path", 400);
    const object = await env.ASSETS.get(templateFileKey(name, revisionId, normalized));
    if (!object) return error("not_found", "Template file not found", 404);
    return new Response(object.body, {
      headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  }

  if (request.method === "DELETE" && url.pathname === `/__nook/api/templates/${name}`) {
    await deleteR2Prefix(env.ASSETS, `templates/${name}/`);
    await registryFetch(env, `/templates/${encodeURIComponent(name)}`, { method: "DELETE" });
    return json({ template: name, deleted: true });
  }

  if (request.method === "POST" && url.pathname.endsWith("/save/start")) {
    const body = (await readJson(request)) as { files?: ManifestFile[] };
    const files = body.files ?? [];
    const validationError = validateManifest(files, {
      requireIndex: false,
      artifactLabel: "template",
    });
    if (validationError) return error("invalid_manifest", validationError, 400);
    const start = await registryFetch(env, `/templates/${encodeURIComponent(name)}/save/start`, {
      method: "POST",
      body: JSON.stringify({ files }),
    });
    if (!start.ok) return start;
    const result = (await start.json()) as {
      saveId: string;
      upload: string[];
      token: string;
      expiredSaveIds: string[];
    };
    for (const expiredSaveId of result.expiredSaveIds) {
      ctx.waitUntil(deleteR2Prefix(env.ASSETS, templateRevisionPrefix(name, expiredSaveId)));
    }
    const { expiredSaveIds: _expiredSaveIds, ...response } = result;
    return json(response);
  }

  if (!saveId) return error("save_not_found", "Template save is required", 404);
  const token = request.headers.get("x-nook-template-token");
  if (!token) return error("unauthorized", "Missing template save token", 401);

  if (request.method === "PUT" && saveAction === "file") {
    const path = url.searchParams.get("path");
    if (!path) return error("invalid_path", "Missing upload path", 400);
    const verify = await registryFetch(
      env,
      `/templates/${encodeURIComponent(name)}/save/${encodeURIComponent(saveId)}/verify-upload`,
      {
        method: "POST",
        body: JSON.stringify({ token, path }),
      },
    );
    if (!verify.ok) return verify;
    const payload = (await verify.json()) as { file: ManifestFile };
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== payload.file.sizeBytes) {
      return error("invalid_upload", "Uploaded file size does not match manifest", 400);
    }
    if ((await sha256Hex(bytes)) !== payload.file.sha256) {
      return error("invalid_upload", "Uploaded file hash does not match manifest", 400);
    }
    await env.ASSETS.put(templateFileKey(name, saveId, payload.file.path), bytes, {
      httpMetadata: { contentType: payload.file.contentType },
    });
    return await registryFetch(
      env,
      `/templates/${encodeURIComponent(name)}/save/${encodeURIComponent(saveId)}/mark-uploaded`,
      {
        method: "POST",
        body: JSON.stringify({ token, path }),
      },
    );
  }

  if (request.method === "POST" && saveAction === "finish") {
    const finish = await registryFetch(
      env,
      `/templates/${encodeURIComponent(name)}/save/${encodeURIComponent(saveId)}/finish`,
      {
        method: "POST",
        body: JSON.stringify({ token }),
      },
    );
    if (!finish.ok) return finish;
    const result = (await finish.json()) as TemplateSummary & {
      previousRevisionId?: string;
    };
    if (result.previousRevisionId) {
      ctx.waitUntil(
        deleteR2Prefix(env.ASSETS, templateRevisionPrefix(name, result.previousRevisionId)),
      );
    }
    const { previousRevisionId: _previousRevisionId, ...summary } = result;
    return json(summary);
  }

  return error("not_found", "Unknown Nook API route", 404);
}

async function handleBaseApi(
  request: Request,
  env: Env,
  url: URL,
  identity: Identity,
  ctx: WorkerExecutionContext,
): Promise<Response> {
  if (
    url.pathname === "/__nook/api/templates" ||
    url.pathname.startsWith("/__nook/api/templates/")
  ) {
    return await handleTemplateApi(request, env, url, ctx);
  }

  if (request.method === "POST" && url.pathname === "/__nook/api/destroy") {
    const sitesResponse = await registryFetch(
      env,
      `/sites?domain=${encodeURIComponent(env.NOOK_DOMAIN)}`,
    );
    if (!sitesResponse.ok) return sitesResponse;
    const payload = (await sitesResponse.json()) as { sites: SiteSummary[] };
    for (const site of payload.sites) {
      await deleteR2Prefix(env.ASSETS, `sites/${site.slug}/`);
      await siteFetch(env, site.slug, "/delete", { method: "POST" });
    }
    await registryFetch(env, "/delete-all", { method: "POST" });
    const objectsDeleted = await deleteR2Prefix(env.ASSETS, "");
    return json({
      deleted: true,
      sitesDeleted: payload.sites.length,
      objectsDeleted,
      actor: identity.actor,
    });
  }

  const match = url.pathname.match(
    /^\/__nook\/api\/sites(?:\/([^/]+))?(?:\/deploy\/([^/]+)\/(file|finish)|\/deploy\/start)?$/,
  );
  if (!match) return error("not_found", "Unknown Nook API route", 404);

  const site = match[1] ? decodeURIComponent(match[1]) : undefined;
  const deploymentId = match[2] ? decodeURIComponent(match[2]) : undefined;
  const deployAction = match[3];

  if (url.pathname === "/__nook/api/sites" && request.method === "GET") {
    return await registryFetch(env, `/sites?domain=${encodeURIComponent(env.NOOK_DOMAIN)}`);
  }

  if (!site) return error("site_not_found", "Site is required", 404);
  const slugError = validateSlug(site);
  if (slugError) return error("invalid_slug", slugError, 400);

  if (request.method === "DELETE" && url.pathname === `/__nook/api/sites/${site}`) {
    await deleteR2Prefix(env.ASSETS, `sites/${site}/`);
    await siteFetch(env, site, "/delete", { method: "POST" });
    await registryFetch(env, `/sites/${encodeURIComponent(site)}`, { method: "DELETE" });
    return json({ site, deleted: true });
  }

  if (request.method === "POST" && url.pathname.endsWith("/deploy/start")) {
    const body = (await readJson(request)) as { files?: ManifestFile[]; public?: boolean };
    const files = body.files ?? [];
    const validationError = validateManifest(files, {
      requireIndex: true,
      artifactLabel: "deployment",
    });
    if (validationError) return error("invalid_manifest", validationError, 400);
    await registryFetch(env, "/sites", {
      method: "POST",
      body: JSON.stringify({ slug: site, domain: env.NOOK_DOMAIN }),
    });
    return await siteFetch(env, site, "/deploy/start", {
      method: "POST",
      body: JSON.stringify({ files, public: body.public === true, actor: identity.actor }),
    });
  }

  if (!deploymentId) return error("deployment_not_found", "Deployment is required", 404);
  const token = request.headers.get("x-nook-deploy-token");
  if (!token) return error("unauthorized", "Missing deploy token", 401);

  if (request.method === "PUT" && deployAction === "file") {
    const path = url.searchParams.get("path");
    if (!path) return error("invalid_path", "Missing upload path", 400);
    const verify = await siteFetch(env, site, "/deploy/verify-upload", {
      method: "POST",
      body: JSON.stringify({ deploymentId, token, path }),
    });
    if (!verify.ok) return verify;
    const payload = (await verify.json()) as { file: ManifestFile };
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== payload.file.sizeBytes) {
      return error("invalid_upload", "Uploaded file size does not match manifest", 400);
    }
    if ((await sha256Hex(bytes)) !== payload.file.sha256) {
      return error("invalid_upload", "Uploaded file hash does not match manifest", 400);
    }
    await env.ASSETS.put(assetKey(site, deploymentId, payload.file.path), bytes, {
      httpMetadata: { contentType: payload.file.contentType },
    });
    return await siteFetch(env, site, "/deploy/mark-uploaded", {
      method: "POST",
      body: JSON.stringify({ deploymentId, token, path }),
    });
  }

  if (request.method === "POST" && deployAction === "finish") {
    const finish = await siteFetch(env, site, "/deploy/finish", {
      method: "POST",
      body: JSON.stringify({ deploymentId, token }),
    });
    if (!finish.ok) return finish;
    const rawResult = (await finish.json()) as {
      visibility: "public" | "private";
      deploymentId: string;
      fileCount: number;
      byteCount: number;
      previousDeploymentId?: string;
    };
    const result = {
      ...rawResult,
      site,
      url: siteUrl(env.NOOK_DOMAIN, site),
    };
    await registryFetch(env, `/sites/${encodeURIComponent(site)}/deploy`, {
      method: "POST",
      body: JSON.stringify({
        latestDeploymentId: result.deploymentId,
        visibility: result.visibility,
      }),
    });
    if (result.previousDeploymentId) {
      ctx.waitUntil(
        deleteR2Prefix(env.ASSETS, `sites/${site}/deployments/${result.previousDeploymentId}/`),
      );
    }
    return json(result);
  }

  return error("not_found", "Unknown Nook API route", 404);
}

async function handleKv(
  request: Request,
  env: Env,
  site: string,
  identity: Identity,
  sitePath: string,
): Promise<Response> {
  return await siteFetch(
    env,
    site,
    `/kv${sitePath.slice("/__nook/kv".length)}${new URL(request.url).search}`,
    {
      method: request.method,
      headers: { "x-nook-actor": identity.actor },
      body: request.body,
    },
  );
}

function shouldSpaFallback(pathname: string): boolean {
  const segment = pathname.split("/").pop() ?? "";
  return !segment.includes(".");
}

export function cacheControlForDeployedAsset(): string {
  return DEPLOYED_ASSET_CACHE_CONTROL;
}

function nookClientScriptTag(site: string): string {
  return `<script src="/${site}/__nook/client.js"></script>`;
}

function injectNookClientScript(response: Response, site: string): Response {
  const scriptTag = nookClientScriptTag(site);
  const injector: HtmlRewriterHandler = {
    element(element) {
      element.prepend(scriptTag, { html: true });
      delete injector.end;
    },
    end(end) {
      end.append(scriptTag, { html: true });
    },
  };

  return new HTMLRewriter().on("body", injector).onDocument(injector).transform(response);
}

async function serveAsset(
  request: Request,
  env: Env,
  site: string,
  sitePath: string,
): Promise<Response> {
  const activeResponse = await siteFetch(env, site, "/active");
  if (!activeResponse.ok) return error("site_not_found", "Site has no active deployment", 404);
  const active = (await activeResponse.json()) as {
    deploymentId: string;
    public: boolean;
    files: ManifestFile[];
  };
  const identity = active.public
    ? await optionalAccessIdentity(request, env)
    : await requireAccessIdentity(request, env);

  if (sitePath === "/__nook/client.js") {
    return new Response(CLIENT_JS, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }
  if (sitePath === "/__nook/kv" || sitePath.startsWith("/__nook/kv/")) {
    return await handleKv(request, env, site, identity, sitePath);
  }
  if (sitePath === RESERVED_PREFIX || sitePath.startsWith(`${RESERVED_PREFIX}/`)) {
    return error("not_found", "Unknown Nook route", 404);
  }

  const normalized = normalizeAssetPath(sitePath);
  if (!normalized) return error("invalid_path", "Invalid path", 400);

  let object = await env.ASSETS.get(assetKey(site, active.deploymentId, normalized));
  let servedPath = normalized;
  if (!object && shouldSpaFallback(normalized)) {
    servedPath = "/index.html";
    object = await env.ASSETS.get(assetKey(site, active.deploymentId, servedPath));
  }
  if (!object) return new Response("Not found", { status: 404 });

  const file = active.files.find((entry) => entry.path === servedPath);
  const contentType =
    object.httpMetadata?.contentType ?? file?.contentType ?? "application/octet-stream";
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": cacheControlForDeployedAsset(),
  });

  if (contentType.startsWith("text/html")) {
    return injectNookClientScript(new Response(object.body ?? "", { headers }), site);
  }

  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parsedHost = parseHost(url, env);
      if (!parsedHost) return error("not_found", "Unknown nook host", 404);

      if (url.pathname === "/__nook/skill") {
        return new Response(SKILL_MARKDOWN, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }

      if (url.pathname.startsWith("/__nook/api/")) {
        const identity = await requireAccessIdentity(request, env);
        return await handleBaseApi(request, env, url, identity, ctx);
      }

      const sitePath = parseSitePath(url.pathname);
      if (!sitePath) return error("not_found", "Unknown Nook route", 404);
      if (sitePath.needsSlashRedirect) {
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = `${redirectUrl.pathname}/`;
        return Response.redirect(redirectUrl.toString(), 308);
      }
      return await serveAsset(request, env, sitePath.slug, sitePath.sitePath);
    } catch (err) {
      if (err instanceof ErrorResponse) return err.toResponse();
      return error("internal_error", err instanceof Error ? err.message : String(err), 500);
    }
  },
};

export class RegistryDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/delete-all") {
      await this.state.storage.deleteAll();
      return json({ deleted: true });
    }

    if (request.method === "GET" && url.pathname === "/templates") {
      const records = await this.state.storage.list<TemplateSummary>({ prefix: "template:" });
      return json({ templates: [...records.values()] });
    }

    const templateManifestMatch = url.pathname.match(/^\/templates\/([^/]+)\/manifest$/);
    if (request.method === "GET" && templateManifestMatch) {
      const name = decodeURIComponent(templateManifestMatch[1]!);
      const template = await this.state.storage.get<TemplateSummary>(`template:${name}`);
      if (!template) return error("template_not_found", "Template not found", 404);
      const files = await this.state.storage.get<ManifestFile[]>(`template-files:${name}`);
      return json({ template, files: files ?? [] });
    }

    const templateSaveStartMatch = url.pathname.match(/^\/templates\/([^/]+)\/save\/start$/);
    if (request.method === "POST" && templateSaveStartMatch) {
      const name = decodeURIComponent(templateSaveStartMatch[1]!);
      const body = (await readJson(request)) as { files: ManifestFile[] };
      const timestamp = now();
      const nowMs = Date.now();
      const saves = await this.state.storage.list<TemplateSaveRecord>({
        prefix: `template-save:${name}:`,
      });
      const expiredSaveIds: string[] = [];
      const expiredSaveKeys: string[] = [];
      let pendingSaves = 0;
      for (const [key, save] of saves.entries()) {
        if (Date.parse(save.expiresAt) < nowMs) {
          expiredSaveIds.push(save.saveId);
          expiredSaveKeys.push(key);
        } else {
          pendingSaves += 1;
        }
      }
      if (expiredSaveKeys.length > 0) await this.state.storage.delete(expiredSaveKeys);
      if (pendingSaves >= MAX_PENDING_TEMPLATE_SAVES) {
        return error("quota_exceeded", "Too many pending saves for this template", 429);
      }

      const save: TemplateSaveRecord = {
        saveId: randomId("tpl"),
        token: randomId("tok"),
        createdAt: timestamp,
        expiresAt: new Date(Date.now() + TEMPLATE_SAVE_SESSION_MS).toISOString(),
        files: body.files,
        uploaded: [],
      };
      await this.state.storage.put(`template-save:${name}:${save.saveId}`, save);
      return json({
        saveId: save.saveId,
        upload: save.files.map((file) => file.path),
        token: save.token,
        expiredSaveIds,
      });
    }

    const templateSaveActionMatch = url.pathname.match(
      /^\/templates\/([^/]+)\/save\/([^/]+)\/(verify-upload|mark-uploaded|finish)$/,
    );
    if (request.method === "POST" && templateSaveActionMatch) {
      const name = decodeURIComponent(templateSaveActionMatch[1]!);
      const saveId = decodeURIComponent(templateSaveActionMatch[2]!);
      const action = templateSaveActionMatch[3]!;
      const body = (await readJson(request)) as { token: string; path?: string };
      const save = await this.requireTemplateSave(name, saveId, body.token);
      if (save instanceof Response) return save;

      if (action === "verify-upload") {
        const file = save.files.find((entry) => entry.path === body.path);
        if (!file) return error("invalid_path", "Path is not in template manifest", 400);
        return json({ file });
      }

      if (action === "mark-uploaded") {
        if (!body.path) return error("invalid_path", "Missing upload path", 400);
        if (!save.uploaded.includes(body.path)) save.uploaded.push(body.path);
        await this.state.storage.put(`template-save:${name}:${saveId}`, save);
        return json({ uploaded: true });
      }

      const uploaded = new Set(save.uploaded);
      const missing = save.files.filter((file) => !uploaded.has(file.path));
      if (missing.length > 0) {
        return error("template_incomplete", "Template save has missing files", 409);
      }
      const existing = await this.state.storage.get<TemplateSummary>(`template:${name}`);
      const timestamp = now();
      const summary: TemplateSummary = {
        name,
        revisionId: save.saveId,
        createdAt: existing?.createdAt ?? save.createdAt,
        updatedAt: timestamp,
        fileCount: save.files.length,
        byteCount: save.files.reduce((total, file) => total + file.sizeBytes, 0),
      };
      await this.state.storage.put(`template:${name}`, summary);
      await this.state.storage.put(`template-files:${name}`, save.files);
      await this.state.storage.delete(`template-save:${name}:${saveId}`);
      return json({ ...summary, previousRevisionId: existing?.revisionId });
    }

    const templateDeleteMatch = url.pathname.match(/^\/templates\/([^/]+)$/);
    if (request.method === "DELETE" && templateDeleteMatch) {
      const name = decodeURIComponent(templateDeleteMatch[1]!);
      const saves = await this.state.storage.list<TemplateSaveRecord>({
        prefix: `template-save:${name}:`,
      });
      await this.state.storage.delete([
        `template:${name}`,
        `template-files:${name}`,
        ...saves.keys(),
      ]);
      return json({ deleted: true });
    }

    if (request.method === "GET" && url.pathname === "/sites") {
      const domain = url.searchParams.get("domain") ?? "";
      const records = await this.state.storage.list<SiteSummary>({ prefix: "site:" });
      return json({
        sites: [...records.values()].map((site) => ({
          ...site,
          url: siteUrl(domain, site.slug),
        })),
      });
    }

    if (request.method === "POST" && url.pathname === "/sites") {
      const body = (await readJson(request)) as { slug: string; domain: string };
      const key = `site:${body.slug}`;
      const existing = await this.state.storage.get<SiteSummary>(key);
      if (existing) return json(existing);
      const timestamp = now();
      const site: SiteSummary = {
        slug: body.slug,
        url: siteUrl(body.domain, body.slug),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.state.storage.put(key, site);
      return json(site, 201);
    }

    const deployMatch = url.pathname.match(/^\/sites\/([^/]+)\/deploy$/);
    if (request.method === "POST" && deployMatch) {
      const slug = decodeURIComponent(deployMatch[1]!);
      const body = (await readJson(request)) as {
        latestDeploymentId: string;
        visibility: "public" | "private";
      };
      const key = `site:${slug}`;
      const existing = await this.state.storage.get<SiteSummary>(key);
      if (!existing) return error("site_not_found", "Site not found", 404);
      const updated: SiteSummary = {
        ...existing,
        updatedAt: now(),
        latestDeploymentId: body.latestDeploymentId,
        visibility: body.visibility,
      };
      await this.state.storage.put(key, updated);
      return json(updated);
    }

    const deleteMatch = url.pathname.match(/^\/sites\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      await this.state.storage.delete(`site:${decodeURIComponent(deleteMatch[1]!)}`);
      return json({ deleted: true });
    }

    return error("not_found", "Unknown registry route", 404);
  }

  private async requireTemplateSave(
    name: string,
    saveId: string,
    token: string,
  ): Promise<TemplateSaveRecord | Response> {
    const save = await this.state.storage.get<TemplateSaveRecord>(
      `template-save:${name}:${saveId}`,
    );
    if (!save) return error("save_not_found", "Template save not found", 404);
    if (save.token !== token) return error("unauthorized", "Invalid template save token", 401);
    if (Date.parse(save.expiresAt) < Date.now()) {
      return error("save_expired", "Template save session expired", 410);
    }
    return save;
  }
}

export class SiteDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/delete") {
      await this.state.storage.deleteAll();
      return json({ deleted: true });
    }

    if (request.method === "GET" && url.pathname === "/active") {
      const site = await this.state.storage.get<SiteState>("site");
      if (!site?.activeDeploymentId)
        return error("deployment_not_found", "No active deployment", 404);
      const deployment = await this.state.storage.get<DeploymentRecord>(
        `deployment:${site.activeDeploymentId}`,
      );
      if (!deployment) return error("deployment_not_found", "Active deployment missing", 404);
      return json({
        deploymentId: deployment.deploymentId,
        public: deployment.public,
        files: deployment.files,
      });
    }

    if (request.method === "POST" && url.pathname === "/deploy/start") {
      const body = (await readJson(request)) as {
        files: ManifestFile[];
        public: boolean;
        actor: string;
      };
      const timestamp = now();
      const nowMs = Date.now();
      const deployments = await this.state.storage.list<DeploymentRecord>({
        prefix: "deployment:",
      });
      let pendingDeployments = 0;
      const expiredPendingKeys: string[] = [];
      for (const [key, deployment] of deployments.entries()) {
        if (deployment.status !== "pending") continue;
        if (Date.parse(deployment.expiresAt) < nowMs) {
          expiredPendingKeys.push(key);
        } else {
          pendingDeployments += 1;
        }
      }
      if (expiredPendingKeys.length > 0) await this.state.storage.delete(expiredPendingKeys);
      if (pendingDeployments >= MAX_PENDING_DEPLOYMENTS) {
        return error("quota_exceeded", "Too many pending deployments for this site", 429);
      }
      const deployment: DeploymentRecord = {
        deploymentId: randomId("dep"),
        status: "pending",
        public: body.public,
        createdAt: timestamp,
        token: randomId("tok"),
        expiresAt: new Date(Date.now() + DEPLOY_SESSION_MS).toISOString(),
        files: body.files,
        uploaded: [],
      };
      const existingSite = await this.state.storage.get<SiteState>("site");
      await this.state.storage.put("site", {
        createdAt: existingSite?.createdAt ?? timestamp,
        updatedAt: timestamp,
        activeDeploymentId: existingSite?.activeDeploymentId,
        activePublic: existingSite?.activePublic,
      });
      await this.state.storage.put(`deployment:${deployment.deploymentId}`, deployment);
      return json({
        deploymentId: deployment.deploymentId,
        upload: deployment.files.map((file) => file.path),
        token: deployment.token,
      });
    }

    if (request.method === "POST" && url.pathname === "/deploy/verify-upload") {
      const body = (await readJson(request)) as {
        deploymentId: string;
        token: string;
        path: string;
      };
      const deploymentResult = await this.requirePendingDeployment(body.deploymentId, body.token);
      if (deploymentResult instanceof Response) return deploymentResult;
      const deployment = deploymentResult;
      const file = deployment.files.find((entry) => entry.path === body.path);
      if (!file) return error("invalid_path", "Path is not in deployment manifest", 400);
      return json({ file });
    }

    if (request.method === "POST" && url.pathname === "/deploy/mark-uploaded") {
      const body = (await readJson(request)) as {
        deploymentId: string;
        token: string;
        path: string;
      };
      const deploymentResult = await this.requirePendingDeployment(body.deploymentId, body.token);
      if (deploymentResult instanceof Response) return deploymentResult;
      const deployment = deploymentResult;
      if (!deployment.uploaded.includes(body.path)) deployment.uploaded.push(body.path);
      await this.state.storage.put(`deployment:${deployment.deploymentId}`, deployment);
      return json({ uploaded: true });
    }

    if (request.method === "POST" && url.pathname === "/deploy/finish") {
      const body = (await readJson(request)) as { deploymentId: string; token: string };
      const deploymentResult = await this.requirePendingDeployment(body.deploymentId, body.token);
      if (deploymentResult instanceof Response) return deploymentResult;
      const deployment = deploymentResult;
      const uploaded = new Set(deployment.uploaded);
      const missing = deployment.files.filter((file) => !uploaded.has(file.path));
      if (missing.length > 0)
        return error("deployment_incomplete", "Deployment has missing files", 409);

      const previous = await this.state.storage.get<SiteState>("site");
      const timestamp = now();
      deployment.status = "active";
      deployment.finishedAt = timestamp;
      await this.state.storage.put(`deployment:${deployment.deploymentId}`, deployment);
      await this.state.storage.put("site", {
        createdAt: previous?.createdAt ?? deployment.createdAt,
        updatedAt: timestamp,
        activeDeploymentId: deployment.deploymentId,
        activePublic: deployment.public,
      });
      return json({
        visibility: deployment.public ? "public" : "private",
        deploymentId: deployment.deploymentId,
        fileCount: deployment.files.length,
        byteCount: deployment.files.reduce((total, file) => total + file.sizeBytes, 0),
        previousDeploymentId: previous?.activeDeploymentId,
      });
    }

    if (url.pathname === "/kv" || url.pathname.startsWith("/kv/")) {
      return await this.handleKv(request, url);
    }

    return error("not_found", "Unknown site route", 404);
  }

  private async requirePendingDeployment(
    deploymentId: string,
    token: string,
  ): Promise<DeploymentRecord | Response> {
    const deployment = await this.state.storage.get<DeploymentRecord>(`deployment:${deploymentId}`);
    if (!deployment) return error("deployment_not_found", "Deployment not found", 404);
    if (deployment.status !== "pending") {
      return error("deployment_not_found", "Deployment is not pending", 409);
    }
    if (deployment.token !== token) return error("unauthorized", "Invalid deploy token", 401);
    if (Date.parse(deployment.expiresAt) < Date.now()) {
      return error("deployment_expired", "Deployment session expired", 410);
    }
    return deployment;
  }

  private async handleKv(request: Request, url: URL): Promise<Response> {
    try {
      const key = decodeURIComponent(url.pathname.slice("/kv/".length));
      if (request.method === "GET" && url.pathname === "/kv") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const records = await this.state.storage.list<KvRecord>({ prefix: "kv:" });
        const keys = [...records.entries()]
          .map(([storageKey, record]) => ({
            key: storageKey.slice("kv:".length),
            sizeBytes: record.sizeBytes,
            updatedAt: record.updatedAt,
          }))
          .filter((entry) => entry.key.startsWith(prefix));
        return json({ keys });
      }

      if (!key || key.length > MAX_KV_KEY_LENGTH)
        return error("invalid_key", "Invalid KV key", 400);
      const storageKey = `kv:${key}`;
      if (request.method === "GET") {
        const record = await this.state.storage.get<KvRecord>(storageKey);
        return json({ value: record?.value ?? null });
      }
      if (request.method === "DELETE") {
        const deleted = await this.state.storage.delete(storageKey);
        return json({ key, deleted });
      }
      if (request.method === "PUT") {
        const value = await readJson(request);
        const serialized = JSON.stringify(value);
        const sizeBytes = new TextEncoder().encode(serialized).length;
        if (sizeBytes > MAX_KV_VALUE_BYTES)
          return error("quota_exceeded", "KV value is too large", 413);
        const existing = await this.state.storage.get<KvRecord>(storageKey);
        const usage = await this.kvUsage();
        const nextKeys = existing ? usage.keyCount : usage.keyCount + 1;
        const nextBytes = usage.bytesUsed - (existing?.sizeBytes ?? 0) + sizeBytes;
        if (nextKeys > MAX_KV_KEYS || nextBytes > MAX_KV_TOTAL_BYTES) {
          return error("quota_exceeded", "KV quota exceeded", 413);
        }
        await this.state.storage.put(storageKey, {
          value,
          sizeBytes,
          updatedAt: now(),
          updatedBy: request.headers.get("x-nook-actor") ?? "unknown",
        });
        return json({ key });
      }
      return error("method_not_allowed", "Method not allowed", 405);
    } catch (err) {
      if (err instanceof ErrorResponse) return err.toResponse();
      return error("internal_error", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async kvUsage(): Promise<{ keyCount: number; bytesUsed: number }> {
    const records = await this.state.storage.list<KvRecord>({ prefix: "kv:" });
    let bytesUsed = 0;
    for (const record of records.values()) bytesUsed += record.sizeBytes;
    return { keyCount: records.size, bytesUsed };
  }
}

class ErrorResponse extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }

  toResponse(): Response {
    return error(this.code, this.message, this.status);
  }
}
