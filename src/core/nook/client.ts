import { readFileSync } from "node:fs";
import type { Config, NookConfig } from "../config/index.js";
import { getNookAccessClientSecret } from "../config/index.js";
import type { NookBackendDeployFile, NookDeployFile } from "./deploy.js";
import { validateNookSiteSlug } from "./validation.js";

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

export type NookKvListResult = {
  site: string;
  keys: Array<{ key: string; sizeBytes: number; updatedAt: string }>;
};

type NookClientOptions = {
  config: NookConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

type NookClientDeployFile = NookDeployFile | NookBackendDeployFile;

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

async function readDeployFileContent(file: NookClientDeployFile): Promise<Blob> {
  if ("readContent" in file) {
    return new Blob([bufferToArrayBuffer(await file.readContent())]);
  }
  return new Blob([bufferToArrayBuffer(readFileSync(file.absolutePath))]);
}

export class NookClient {
  private readonly config: NookConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NookClientOptions) {
    this.config = options.config;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(await formatNookHttpError(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async readSkill(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl()}/__nook/skill`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await formatNookHttpError(response));
    }
    return await response.text();
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
      const file = filesByPath.get(path);
      if (!file) {
        throw new Error(`worker requested unknown upload path '${path}'`);
      }
      const uploadUrl = `${this.baseUrl()}/__nook/api/sites/${encodeURIComponent(args.site)}/deploy/${encodeURIComponent(start.deploymentId)}/file?path=${encodeURIComponent(path)}`;
      const response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "content-type": file.contentType,
          "x-nook-deploy-token": start.token,
        },
        body: await readDeployFileContent(file),
      });
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

  async getKv(site: string, key: string): Promise<unknown> {
    const result = await this.requestJson<{ value: unknown }>(
      `${this.siteUrl(site)}/__nook/kv/${encodeURIComponent(key)}`,
    );
    return result.value;
  }

  async putKv(site: string, key: string, value: unknown): Promise<{ site: string; key: string }> {
    return await this.requestJson(`${this.siteUrl(site)}/__nook/kv/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  }

  async deleteKv(
    site: string,
    key: string,
  ): Promise<{ site: string; key: string; deleted: boolean }> {
    return await this.requestJson(`${this.siteUrl(site)}/__nook/kv/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  async listKv(site: string, prefix?: string): Promise<NookKvListResult> {
    const url = new URL(`${this.siteUrl(site)}/__nook/kv`);
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
}): NookClient {
  if (!args.config.nook) {
    throw new Error("nook is not configured. add a nook block to Tau config.");
  }
  return new NookClient({
    config: args.config.nook,
    env: args.env,
    fetchImpl: args.fetchImpl,
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
