import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config, NookConfig } from "../config/index.js";
import { getNookAccessClientSecret } from "../config/index.js";
import type { NookBackendDeployFile, NookDeployFile } from "./deploy.js";
import {
  type NookManifestFile,
  validateNookSiteSlug,
  validateNookTemplateManifest,
  validateNookTemplateName,
} from "./validation.js";

export type NookVisibility = "public" | "private";

export type NookSiteSummary = {
  slug: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  latestDeploymentId?: string;
  visibility?: NookVisibility;
  kv?: {
    keyCount: number;
    bytesUsed: number;
    maxKeys: number;
    maxBytes: number;
  };
};

export type NookDeployResult = {
  site: string;
  url: string;
  visibility: NookVisibility;
  deploymentId: string;
  fileCount: number;
  byteCount: number;
};

export type NookSiteManifestResult = {
  site: string;
  deploymentId: string;
  visibility: NookVisibility;
  fileCount: number;
  byteCount: number;
  files: NookManifestFile[];
};

export type NookSiteCopyResult = Omit<NookSiteManifestResult, "files"> & {
  directory: string;
};

export type NookKvListResult = {
  site: string;
  keys: Array<{ key: string; sizeBytes: number; updatedAt: string }>;
};

export type NookTemplateSummary = {
  name: string;
  revisionId: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  byteCount: number;
};

export type NookTemplateManifestResult = {
  template: NookTemplateSummary;
  files: NookManifestFile[];
};

export type NookTemplateCopyResult = NookTemplateSummary & {
  directory: string;
};

type NookClientOptions = {
  config: NookConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

type NookClientDeployFile = NookDeployFile | NookBackendDeployFile;

type NookDownloadedFile = NookManifestFile & {
  content: Buffer;
};

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

function validateCopyDestination(directory: string, artifact: string): void {
  if (!existsSync(directory))
    throw new Error(`${artifact} copy destination does not exist: ${directory}`);
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`${artifact} copy destination is not a directory: ${directory}`);
  }
  if (readdirSync(directory).length > 0) {
    throw new Error(`${artifact} copy destination is not empty: ${directory}`);
  }
}

function writeDownloadedFiles(directory: string, files: NookDownloadedFile[]): void {
  for (const file of files) {
    const destination = join(directory, file.path.replace(/^\/+/, ""));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
}

async function readDeployFileContent(
  file: NookClientDeployFile,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  signal?.throwIfAborted();
  if ("readContent" in file) {
    const content = await file.readContent();
    signal?.throwIfAborted();
    return new Blob([bufferToArrayBuffer(content)]);
  }
  return new Blob([bufferToArrayBuffer(readFileSync(file.absolutePath))]);
}

export class NookClient {
  private readonly config: NookConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly signal: AbortSignal | undefined;

  constructor(options: NookClientOptions) {
    this.config = options.config;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signal = options.signal;
  }

  private throwIfAborted(): void {
    this.signal?.throwIfAborted();
  }

  baseUrl(): string {
    return `https://${this.config.domain}`;
  }

  siteUrl(site: string): string {
    const validation = validateNookSiteSlug(site);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    return `https://${this.config.domain}/${site}`;
  }

  templateApiUrl(name: string): string {
    const validation = validateNookTemplateName(name);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    return `${this.baseUrl()}/__nook/api/templates/${encodeURIComponent(name)}`;
  }

  private siteKvApiUrl(site: string): string {
    const validation = validateNookSiteSlug(site);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    return `${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(site)}/kv`;
  }

  private authHeaders(): Record<string, string> {
    const secret = getNookAccessClientSecret(this.config, this.env);
    if (!this.config.accessClientId || !secret) {
      return {};
    }
    return {
      "CF-Access-Client-Id": this.config.accessClientId,
      "CF-Access-Client-Secret": secret,
    };
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    this.throwIfAborted();
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: this.signal,
    });
    this.throwIfAborted();

    if (!response.ok) {
      throw new Error(await formatNookHttpError(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const result = (await response.json()) as T;
    this.throwIfAborted();
    return result;
  }

  async readSkill(): Promise<string> {
    this.throwIfAborted();
    const response = await this.fetchImpl(`${this.baseUrl()}/__nook/skill`, {
      headers: this.authHeaders(),
      signal: this.signal,
    });
    this.throwIfAborted();
    if (!response.ok) {
      throw new Error(await formatNookHttpError(response));
    }
    const skill = await response.text();
    this.throwIfAborted();
    return skill;
  }

  async listSites(): Promise<NookSiteSummary[]> {
    const result = await this.requestJson<{ sites: NookSiteSummary[] }>(
      `${this.baseUrl()}/__nook/api/sites`,
    );
    return result.sites;
  }

  async deleteSite(site: string): Promise<{ site: string; deleted: boolean }> {
    const result = await this.requestJson<{ site: string; deleted: boolean }>(
      `${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(site)}`,
      { method: "DELETE" },
    );
    return result;
  }

  async getSiteManifest(site: string): Promise<NookSiteManifestResult> {
    return await this.requestJson<NookSiteManifestResult>(
      `${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(site)}`,
    );
  }

  async downloadSiteFile(site: string, deploymentId: string, path: string): Promise<Buffer> {
    const url = new URL(`${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(site)}/file`);
    url.searchParams.set("deployment", deploymentId);
    url.searchParams.set("path", path);
    this.throwIfAborted();
    const response = await this.fetchImpl(url, {
      headers: this.authHeaders(),
      signal: this.signal,
    });
    this.throwIfAborted();
    if (!response.ok) throw new Error(await formatNookHttpError(response));
    const content = Buffer.from(await response.arrayBuffer());
    this.throwIfAborted();
    return content;
  }

  async downloadSiteFiles(
    site: string,
    manifest: NookSiteManifestResult,
  ): Promise<NookDownloadedFile[]> {
    validateNookTemplateManifest(manifest.files);
    const byteCount = manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
    if (manifest.fileCount !== manifest.files.length || manifest.byteCount !== byteCount) {
      throw new Error("site manifest summary does not match its files");
    }
    const downloaded: NookDownloadedFile[] = [];
    for (const file of manifest.files) {
      this.throwIfAborted();
      const content = await this.downloadSiteFile(site, manifest.deploymentId, file.path);
      this.throwIfAborted();
      if (content.byteLength !== file.sizeBytes) {
        throw new Error(`site file '${file.path}' size does not match manifest`);
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== file.sha256) {
        throw new Error(`site file '${file.path}' hash does not match manifest`);
      }
      downloaded.push({ ...file, content });
    }
    return downloaded;
  }

  async copySiteToDirectory(site: string, directory: string): Promise<NookSiteCopyResult> {
    validateCopyDestination(directory, "site");
    const manifest = await this.getSiteManifest(site);
    const files = await this.downloadSiteFiles(site, manifest);
    writeDownloadedFiles(directory, files);
    const { files: _files, ...result } = manifest;
    return { ...result, directory };
  }

  async deploySite(args: {
    site: string;
    files: NookClientDeployFile[];
    visibility: NookVisibility;
  }): Promise<NookDeployResult> {
    const start = await this.requestJson<{
      deploymentId: string;
      upload: string[];
      token: string;
    }>(`${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(args.site)}/deploy/start`, {
      method: "POST",
      body: JSON.stringify({
        public: args.visibility === "public",
        files: args.files.map(({ path, sizeBytes, contentType, sha256 }) => ({
          path,
          sizeBytes,
          contentType,
          sha256,
        })),
      }),
    });

    const filesByPath = new Map(args.files.map((file) => [file.path, file]));
    for (const path of start.upload) {
      this.throwIfAborted();
      const file = filesByPath.get(path);
      if (!file) {
        throw new Error(`worker requested unknown upload path '${path}'`);
      }
      const uploadUrl = `${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(args.site)}/deploy/${encodeURIComponent(start.deploymentId)}/file?path=${encodeURIComponent(path)}`;
      const body = await readDeployFileContent(file, this.signal);
      this.throwIfAborted();
      const response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "content-type": file.contentType,
          "x-nook-deploy-token": start.token,
        },
        body,
        signal: this.signal,
      });
      this.throwIfAborted();
      if (!response.ok) {
        throw new Error(await formatNookHttpError(response));
      }
    }

    const finish = await this.requestJson<NookDeployResult>(
      `${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(args.site)}/deploy/${encodeURIComponent(start.deploymentId)}/finish`,
      {
        method: "POST",
        headers: { "x-nook-deploy-token": start.token },
      },
    );
    return finish;
  }

  async listTemplates(): Promise<NookTemplateSummary[]> {
    const result = await this.requestJson<{ templates: NookTemplateSummary[] }>(
      `${this.baseUrl()}/__nook/api/templates`,
    );
    return result.templates;
  }

  async getTemplateManifest(name: string): Promise<NookTemplateManifestResult> {
    return await this.requestJson<NookTemplateManifestResult>(this.templateApiUrl(name));
  }

  async saveTemplate(args: {
    name: string;
    files: NookClientDeployFile[];
  }): Promise<NookTemplateSummary> {
    const start = await this.requestJson<{
      saveId: string;
      upload: string[];
      token: string;
    }>(`${this.templateApiUrl(args.name)}/save/start`, {
      method: "POST",
      body: JSON.stringify({
        files: args.files.map(({ path, sizeBytes, contentType, sha256 }) => ({
          path,
          sizeBytes,
          contentType,
          sha256,
        })),
      }),
    });

    const filesByPath = new Map(args.files.map((file) => [file.path, file]));
    for (const path of start.upload) {
      this.throwIfAborted();
      const file = filesByPath.get(path);
      if (!file) {
        throw new Error(`worker requested unknown upload path '${path}'`);
      }
      const uploadUrl = `${this.templateApiUrl(args.name)}/save/${encodeURIComponent(start.saveId)}/file?path=${encodeURIComponent(path)}`;
      const body = await readDeployFileContent(file, this.signal);
      this.throwIfAborted();
      const response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "content-type": file.contentType,
          "x-nook-template-token": start.token,
        },
        body,
        signal: this.signal,
      });
      this.throwIfAborted();
      if (!response.ok) {
        throw new Error(await formatNookHttpError(response));
      }
    }

    return await this.requestJson<NookTemplateSummary>(
      `${this.templateApiUrl(args.name)}/save/${encodeURIComponent(start.saveId)}/finish`,
      {
        method: "POST",
        headers: { "x-nook-template-token": start.token },
      },
    );
  }

  async deleteTemplate(name: string): Promise<{ template: string; deleted: boolean }> {
    return await this.requestJson(this.templateApiUrl(name), { method: "DELETE" });
  }

  async downloadTemplateFile(name: string, revisionId: string, path: string): Promise<Buffer> {
    const url = new URL(`${this.templateApiUrl(name)}/file`);
    url.searchParams.set("revision", revisionId);
    url.searchParams.set("path", path);
    this.throwIfAborted();
    const response = await this.fetchImpl(url, {
      headers: this.authHeaders(),
      signal: this.signal,
    });
    this.throwIfAborted();
    if (!response.ok) {
      throw new Error(await formatNookHttpError(response));
    }
    const content = Buffer.from(await response.arrayBuffer());
    this.throwIfAborted();
    return content;
  }

  async downloadTemplateFiles(
    name: string,
    manifest: NookTemplateManifestResult,
  ): Promise<NookDownloadedFile[]> {
    validateNookTemplateManifest(manifest.files);
    const byteCount = manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
    if (
      manifest.template.fileCount !== manifest.files.length ||
      manifest.template.byteCount !== byteCount
    ) {
      throw new Error("template manifest summary does not match its files");
    }
    const downloaded: NookDownloadedFile[] = [];
    for (const file of manifest.files) {
      this.throwIfAborted();
      const content = await this.downloadTemplateFile(
        name,
        manifest.template.revisionId,
        file.path,
      );
      this.throwIfAborted();
      if (content.byteLength !== file.sizeBytes) {
        throw new Error(`template file '${file.path}' size does not match manifest`);
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== file.sha256) {
        throw new Error(`template file '${file.path}' hash does not match manifest`);
      }
      downloaded.push({ ...file, content });
    }
    return downloaded;
  }

  async copyTemplateToDirectory(name: string, directory: string): Promise<NookTemplateCopyResult> {
    validateCopyDestination(directory, "template");
    const manifest = await this.getTemplateManifest(name);
    const files = await this.downloadTemplateFiles(name, manifest);
    writeDownloadedFiles(directory, files);
    return {
      ...manifest.template,
      directory,
    };
  }

  async getKv(site: string, key: string): Promise<unknown> {
    const result = await this.requestJson<{ value: unknown }>(
      `${this.siteKvApiUrl(site)}/${encodeURIComponent(key)}`,
    );
    return result.value;
  }

  async putKv(site: string, key: string, value: unknown): Promise<{ site: string; key: string }> {
    return await this.requestJson(`${this.siteKvApiUrl(site)}/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  }

  async deleteKv(
    site: string,
    key: string,
  ): Promise<{ site: string; key: string; deleted: boolean }> {
    return await this.requestJson(`${this.siteKvApiUrl(site)}/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  async listKv(site: string, prefix?: string): Promise<NookKvListResult> {
    const url = new URL(this.siteKvApiUrl(site));
    if (prefix) {
      url.searchParams.set("prefix", prefix);
    }
    return await this.requestJson(url.toString());
  }
}

export function createNookClientFromConfig(args: {
  config: Config;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): NookClient {
  if (!args.config.nook) {
    throw new Error("nook is not configured. add a nook block to Tau config.");
  }
  return new NookClient({
    config: args.config.nook,
    env: args.env,
    fetchImpl: args.fetchImpl,
    signal: args.signal,
  });
}

async function formatNookHttpError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (parsed.error?.message) {
      return `nook request failed (${response.status} ${response.statusText}): ${parsed.error.message}`;
    }
  } catch {
    // fall through
  }
  const detail = text.trim();
  return `nook request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`;
}
