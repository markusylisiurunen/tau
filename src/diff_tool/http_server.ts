import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffReviewFile, DiffReviewSessionContextResult } from "../core/diff_review/index.js";
import type { DiffReviewProtocolClient } from "./protocol_client.js";
import { DiffToolReviewStateStore } from "./review_state.js";
import type {
  DiffToolBootstrapPayload,
  DiffToolCreateThreadPayload,
  DiffToolGetDiffResult,
  DiffToolStatePatch,
} from "./shared_types.js";

export type {
  DiffToolBootstrapPayload,
  DiffToolCommentThread,
  DiffToolLineSide,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadMessage,
} from "./shared_types.js";

export type StartDiffToolHttpServerOptions = {
  client: DiffReviewProtocolClient;
  host?: string;
  port?: number;
};

export type StartedDiffToolHttpServer = {
  url: string;
};

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

const REVIEW_BRIEF_PROMPT = [
  "Read through the full diff, then write a reviewer brief.",
  "",
  "The brief orients a technically competent reviewer before they start reading code. A good brief compresses review time without compressing judgment: the reviewer should finish reading it with an architectural mental model of the change, a sense of where risk lives, and a short list of things to consciously verify.",
  "",
  "Use exactly these headings:",
  "",
  "## Summary",
  "## Behavior changes",
  "## Verify",
  "",
  "**Summary** builds the big-picture mental model. Not what each file does, but the architectural shape of the change: what design decisions were made, how components interact differently now, which areas carry risk, and what can be safely skimmed. When the diff spans multiple concerns, group by concern. The reader should feel oriented before they touch any code.",
  "",
  "**Behavior changes** translates code into runtime consequences. Reviewers are good at reading syntax but unreliable at inferring behavioral impact across a large diff. Bridge that gap. Show before/after sketches or pseudo-code when that communicates faster than prose. Focus on contract shifts, failure modes, defaults, ordering, and side effects.",
  "",
  "**Verify** surfaces the questions worth stopping for. Not obvious issues, but assumptions that may be intentional yet deserve conscious confirmation: scope boundaries, compatibility expectations, failure semantics, rollout risk. Phrase as direct questions.",
  "",
  "Keep the brief readable in under a minute. Mix prose, bullets, and code naturally. Be dense and specific. Do not pad thin sections or restate every file. The reviewer will read the code, so the brief should complement the diff rather than re-explain what is already clear from reading it. Focus on what code alone does not communicate well: intent, architectural reasoning, non-obvious consequences, and cross-cutting concerns.",
].join("\n");

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function resolveStaticDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(thisFile, "..", "app", "dist");
}

export class DiffToolHttpServer {
  private readonly client: DiffReviewProtocolClient;
  private readonly host: string;
  private readonly port: number;
  private readonly removeClientCloseListener: () => void;
  private readonly staticDir: string;
  private readonly reviewState = new DiffToolReviewStateStore();
  private context?: DiffReviewSessionContextResult;
  private files: DiffReviewFile[] = [];
  private server = createServer((request, response) => {
    void this.handleRequest(request, response).catch((error) => {
      this.sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  private closed = false;
  private closeResolver?: () => void;
  private readonly closePromise = new Promise<void>((resolve) => {
    this.closeResolver = resolve;
  });

  constructor(options: StartDiffToolHttpServerOptions) {
    this.client = options.client;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.staticDir = resolveStaticDir();
    this.removeClientCloseListener = this.client.onClose(() => {
      if (this.closed) {
        return;
      }
      void this.close();
    });
  }

  async start(): Promise<StartedDiffToolHttpServer> {
    try {
      await this.client.connect();
      this.context = await this.client.getContext();
      this.files = (await this.client.listFiles()).files;

      await this.listen();
      const address = this.server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to start diff tool http server");
      }

      const url = `http://${this.host}:${String(address.port)}`;
      await this.client.setUiText({ text: `browser diff tool: ${url}` });

      return {
        url,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.closePromise;
      return;
    }

    this.closed = true;
    this.removeClientCloseListener();
    await this.closeHttpServer();
    await this.client.close();
    this.closeResolver?.();
    this.closeResolver = undefined;
  }

  async waitUntilClosed(): Promise<void> {
    await this.closePromise;
  }

  async cancel(): Promise<void> {
    try {
      await this.client.cancelSession();
    } catch {
      // ignore
    }
    await this.close();
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };

      this.server.once("error", onError);
      this.server.once("listening", onListening);

      try {
        this.server.listen(this.port, this.host);
      } catch (error) {
        this.server.off("error", onError);
        this.server.off("listening", onListening);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async closeHttpServer(): Promise<void> {
    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? this.host}`);

    if (method === "GET" && requestUrl.pathname === "/api/bootstrap") {
      const context = this.context;
      if (!context) {
        throw new Error("diff tool session context is unavailable");
      }

      this.sendJson(response, 200, {
        context,
        files: this.files,
        state: this.reviewState.getState(),
      } satisfies DiffToolBootstrapPayload);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/diff") {
      const path = requestUrl.searchParams.get("path")?.trim() || undefined;
      const diff = await this.client.getDiff(path ? { path } : {});
      this.sendJson(response, 200, diff satisfies DiffToolGetDiffResult);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/state") {
      const payload = parseStatePatch(await this.readJsonBody(request));
      this.reviewState.updateState(payload);
      this.sendJson(response, 200, { state: this.reviewState.getState() });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread") {
      const payload = parseCreateThreadPayload(await this.readJsonBody(request));
      if (!payload) {
        this.sendJson(response, 400, { error: "invalid thread payload" });
        return;
      }

      this.reviewState.createThread(payload);
      this.sendJson(response, 200, { state: this.reviewState.getState() });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/reply") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!this.reviewState.findThread(id)) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      if (!text) {
        this.sendJson(response, 400, { error: "reply text is required" });
        return;
      }

      this.reviewState.addReply(id, text);
      this.sendJson(response, 200, { state: this.reviewState.getState() });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/delete") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const removed = this.reviewState.deleteThread(id);
      if (!removed) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }

      this.sendJson(response, 200, { state: this.reviewState.getState() });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/resolve") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      if (!this.reviewState.findThread(id)) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      if (typeof payload.resolved !== "boolean") {
        this.sendJson(response, 400, { error: "resolved flag is required" });
        return;
      }

      this.reviewState.setThreadResolved(id, payload.resolved);
      this.sendJson(response, 200, { state: this.reviewState.getState() });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/collapse") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      if (!this.reviewState.findThread(id)) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      if (typeof payload.collapsed !== "boolean") {
        this.sendJson(response, 400, { error: "collapsed flag is required" });
        return;
      }

      this.reviewState.setThreadCollapsed(id, payload.collapsed);
      this.sendJson(response, 200, { state: this.reviewState.getState() });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread-message") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const thread = this.reviewState.findThread(id);
      if (!thread) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }

      const message = this.reviewState.buildThreadAgentMessage(id);
      if (!message) {
        this.sendJson(response, 400, { error: "thread has no pending user message" });
        return;
      }

      this.reviewState.setThreadLoading(id, true);
      try {
        const result = await this.client.submitThreadMessage(
          thread.threadId ? { threadId: thread.threadId, message } : { message },
        );
        this.reviewState.applyThreadResponse(id, result);
        this.sendJson(response, 200, { state: this.reviewState.getState() });
      } catch (error) {
        this.reviewState.setThreadLoading(id, false);
        throw error;
      }
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/brief/generate") {
      const currentState = this.reviewState.getState();
      if (currentState.brief.loading) {
        this.sendJson(response, 409, { error: "brief generation already in progress" });
        return;
      }

      this.reviewState.startBriefGeneration();
      try {
        const result = await this.client.submitThreadMessage({ message: REVIEW_BRIEF_PROMPT });
        this.reviewState.applyBriefResult(result);
        this.sendJson(response, 200, { state: this.reviewState.getState() });
      } catch (error) {
        this.reviewState.setBriefLoading(false);
        throw error;
      }
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/review") {
      const result = await this.client.returnReview({
        review: this.reviewState.buildReviewText(),
      });
      response.once("finish", () => {
        void this.close();
      });
      this.sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/cancel") {
      const result = await this.client.cancelSession();
      response.once("finish", () => {
        void this.close();
      });
      this.sendJson(response, 200, result);
      return;
    }

    if (method === "GET") {
      if (this.serveStaticFile(requestUrl.pathname, response)) {
        return;
      }
    }

    this.sendJson(response, 404, { error: "not found" });
  }

  private serveStaticFile(pathname: string, response: ServerResponse): boolean {
    const normalized = normalize(pathname === "/" ? "/index.html" : pathname);
    if (normalized.includes("..")) {
      return false;
    }

    const filePath = join(this.staticDir, normalized);
    if (!filePath.startsWith(this.staticDir)) {
      return false;
    }

    if (!existsSync(filePath)) {
      if (pathname !== "/" && !extname(pathname)) {
        return this.serveStaticFile("/index.html", response);
      }
      return false;
    }

    const ext = extname(filePath);
    const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-store" : "public, max-age=31536000, immutable";

    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch {
      return false;
    }

    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": cacheControl,
    });
    response.end(content);
    return true;
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
      if (totalBytes > JSON_BODY_LIMIT_BYTES) {
        throw new Error("request body is too large");
      }
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("request body must be a json object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `invalid json body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    if (response.headersSent) {
      return;
    }

    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }
}

function parseStatePatch(payload: Record<string, unknown>): DiffToolStatePatch {
  return {
    ...(payload.diffStyle === "split" || payload.diffStyle === "stacked"
      ? { diffStyle: payload.diffStyle }
      : {}),
    ...(payload.overflowMode === "wrap" || payload.overflowMode === "scroll"
      ? { overflowMode: payload.overflowMode }
      : {}),
    ...(typeof payload.sidebarOpen === "boolean" ? { sidebarOpen: payload.sidebarOpen } : {}),
    ...(Array.isArray(payload.collapsedFileIds)
      ? {
          collapsedFileIds: payload.collapsedFileIds.flatMap((value) =>
            typeof value === "string" && value.trim() ? [value] : [],
          ),
        }
      : {}),
    ...(Array.isArray(payload.viewedFileIds)
      ? {
          viewedFileIds: payload.viewedFileIds.flatMap((value) =>
            typeof value === "string" && value.trim() ? [value] : [],
          ),
        }
      : {}),
  };
}

function parseCreateThreadPayload(
  payload: Record<string, unknown>,
): DiffToolCreateThreadPayload | undefined {
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const fileId = typeof payload.fileId === "string" ? payload.fileId.trim() : "";
  const filePath = typeof payload.filePath === "string" ? payload.filePath.trim() : "";
  const lineNumber =
    typeof payload.lineNumber === "number" && Number.isInteger(payload.lineNumber)
      ? payload.lineNumber
      : NaN;
  const side = payload.side === "additions" || payload.side === "deletions" ? payload.side : null;
  if (!body || !fileId || !filePath || !Number.isInteger(lineNumber) || lineNumber < 0 || !side) {
    return undefined;
  }

  return {
    body,
    fileId,
    filePath,
    lineNumber,
    side,
  };
}
