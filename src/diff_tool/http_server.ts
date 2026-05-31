import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffReviewFile, DiffReviewSessionContextResult } from "../core/diff_review/index.js";
import type { DiffReviewProtocolClient } from "./protocol_client.js";
import {
  buildDiffReviewBootstrapPrompt,
  buildDiffReviewBriefPrompt,
  buildDiffReviewCommentThreadPrompt,
} from "./review_prompts.js";
import { DiffToolReviewStateStore } from "./review_state.js";
import type {
  DiffToolBootstrapPayload,
  DiffToolCodeTheme,
  DiffToolCreateThreadPayload,
  DiffToolCreateThreadResponse,
  DiffToolGetDiffResult,
  DiffToolStatePatch,
} from "./shared_types.js";
import { DIFF_TOOL_CODE_THEMES } from "./shared_types.js";

export type {
  DiffToolBootstrapPayload,
  DiffToolCommentThread,
  DiffToolDetachedThreadAnchor,
  DiffToolLineSide,
  DiffToolLineThreadAnchor,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadAnchor,
  DiffToolThreadMessage,
} from "./shared_types.js";

export type StartDiffToolHttpServerOptions = {
  client: DiffReviewProtocolClient;
  codeTheme?: DiffToolCodeTheme;
  host?: string;
  port?: number;
};

export type StartedDiffToolHttpServer = {
  url: string;
};

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

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
  private readonly removeSessionCloseListener: () => void;
  private readonly staticDir: string;
  private readonly reviewState: DiffToolReviewStateStore;
  private context?: DiffReviewSessionContextResult;
  private files: DiffReviewFile[] = [];
  private bootstrapThreadPromise?: Promise<string>;
  private httpServerClosePromise?: Promise<void>;
  private sessionClosing = false;
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
    this.reviewState = new DiffToolReviewStateStore({
      codeTheme: options.codeTheme,
    });
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.staticDir = resolveStaticDir();
    this.removeClientCloseListener = this.client.onClose(() => {
      if (this.closed) {
        return;
      }
      void this.closeFromProtocol();
    });
    this.removeSessionCloseListener = this.client.onSessionClose(() => {
      this.sessionClosing = true;
      void this.closeHttpServer();
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
      await this.client.setUiText({ text: url });
      void this.startBootstrapThread().catch(() => {});

      return {
        url,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.closeInternal({ closeClient: true });
  }

  async waitUntilClosed(): Promise<void> {
    await this.closePromise;
  }

  private async closeFromProtocol(): Promise<void> {
    await this.closeInternal({ closeClient: false });
  }

  private async closeInternal(options: { closeClient: boolean }): Promise<void> {
    if (this.closed) {
      await this.closePromise;
      return;
    }

    this.closed = true;
    this.removeClientCloseListener();
    this.removeSessionCloseListener();
    await this.closeHttpServer();
    if (options.closeClient) {
      await this.client.close();
    }
    this.closeResolver?.();
    this.closeResolver = undefined;
  }

  async cancel(): Promise<void> {
    try {
      await this.client.cancelSession();
      return;
    } catch {
      await this.close();
    }
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
    if (this.httpServerClosePromise) {
      await this.httpServerClosePromise;
      return;
    }
    if (!this.server.listening) {
      return;
    }

    this.httpServerClosePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          this.httpServerClosePromise = undefined;
          reject(error);
          return;
        }
        resolve();
      });
    });
    await this.httpServerClosePromise;
  }

  private async bootstrapReviewContext(): Promise<string> {
    const result = await this.client.submitThreadMessage({
      message: buildDiffReviewBootstrapPrompt(),
    });
    return result.threadId;
  }

  private startBootstrapThread(): Promise<string> {
    if (this.bootstrapThreadPromise) {
      return this.bootstrapThreadPromise;
    }
    if (this.closed) {
      return Promise.reject(new Error("diff tool http server is closed"));
    }

    const promise = this.bootstrapReviewContext().catch((error) => {
      if (this.bootstrapThreadPromise === promise) {
        this.bootstrapThreadPromise = undefined;
      }
      throw error;
    });
    this.bootstrapThreadPromise = promise;
    void promise.catch(() => {});
    return promise;
  }

  private async getBootstrapThreadId(): Promise<string> {
    return await this.startBootstrapThread();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? this.host}`);

    if (this.sessionClosing && requestUrl.pathname.startsWith("/api/")) {
      this.sendJson(response, 409, { error: "diff review session is closing" });
      return;
    }

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

      const threadId = this.reviewState.createThread(payload);
      this.sendJson(response, 200, {
        state: this.reviewState.getState(),
        threadId,
      } satisfies DiffToolCreateThreadResponse);
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

    if (method === "POST" && requestUrl.pathname === "/api/thread-message/delete") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const messageIndex =
        typeof payload.messageIndex === "number" && Number.isInteger(payload.messageIndex)
          ? payload.messageIndex
          : -1;
      if (!this.reviewState.findThread(id)) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }

      const removed = this.reviewState.deleteThreadMessage(id, messageIndex);
      if (!removed) {
        this.sendJson(response, 400, { error: "message not found" });
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
          thread.threadId
            ? { threadId: thread.threadId, message }
            : {
                forkFromThreadId: await this.getBootstrapThreadId(),
                message: buildDiffReviewCommentThreadPrompt(message),
              },
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
        const result = await this.client.submitThreadMessage({
          forkFromThreadId: await this.getBootstrapThreadId(),
          message: buildDiffReviewBriefPrompt(),
        });
        this.reviewState.applyBriefResult(result);
        this.sendJson(response, 200, { state: this.reviewState.getState() });
      } catch (error) {
        this.reviewState.setBriefLoading(false);
        throw error;
      }
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/review") {
      const payload = parseReviewPayload(await this.readJsonBody(request));
      const result = await this.client.returnReview({
        review: this.reviewState.buildReviewText(payload.message),
      });
      this.sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/cancel") {
      const result = await this.client.cancelSession();
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

function parseReviewPayload(payload: Record<string, unknown>): { message?: string } {
  return typeof payload.message === "string" && payload.message.trim()
    ? { message: payload.message }
    : {};
}

const codeThemes = new Set<NonNullable<DiffToolStatePatch["codeTheme"]>>(DIFF_TOOL_CODE_THEMES);

function parseStatePatch(payload: Record<string, unknown>): DiffToolStatePatch {
  return {
    ...(payload.diffStyle === "split" || payload.diffStyle === "stacked"
      ? { diffStyle: payload.diffStyle }
      : {}),
    ...(payload.overflowMode === "wrap" || payload.overflowMode === "scroll"
      ? { overflowMode: payload.overflowMode }
      : {}),
    ...(typeof payload.codeTheme === "string" &&
    codeThemes.has(payload.codeTheme as NonNullable<DiffToolStatePatch["codeTheme"]>)
      ? { codeTheme: payload.codeTheme as NonNullable<DiffToolStatePatch["codeTheme"]> }
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
  const anchor =
    payload.anchor && typeof payload.anchor === "object" && !Array.isArray(payload.anchor)
      ? (payload.anchor as Record<string, unknown>)
      : null;
  if (!body || !anchor) {
    return undefined;
  }

  if (anchor.kind === "detached") {
    return {
      body,
      anchor: { kind: "detached" },
    };
  }

  const fileId = typeof anchor.fileId === "string" ? anchor.fileId.trim() : "";
  const filePath = typeof anchor.filePath === "string" ? anchor.filePath.trim() : "";
  const lineNumber =
    typeof anchor.lineNumber === "number" && Number.isInteger(anchor.lineNumber)
      ? anchor.lineNumber
      : NaN;
  const side = anchor.side === "additions" || anchor.side === "deletions" ? anchor.side : null;
  if (
    anchor.kind !== "line" ||
    !fileId ||
    !filePath ||
    !Number.isInteger(lineNumber) ||
    lineNumber < 0 ||
    !side
  ) {
    return undefined;
  }

  return {
    body,
    anchor: {
      kind: "line",
      fileId,
      filePath,
      lineNumber,
      side,
    },
  };
}
