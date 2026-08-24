import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DiffReviewFile,
  DiffReviewSessionContextResult,
  DiffReviewSubmission,
} from "../core/diff_review/index.js";
import type { DiffReviewProtocolClient } from "./protocol_client.js";
import {
  buildDiffReviewBootstrapPrompt,
  buildDiffReviewCommentThreadPrompt,
  buildDiffReviewGuideOperationsPrompt,
  buildDiffReviewGuidePrompt,
  parseDiffReviewGuideOperationsResponse,
  parseDiffReviewGuideResponse,
} from "./review_prompts.js";
import { DiffToolReviewStateStore } from "./review_state.js";
import {
  createDiffReviewScopeFingerprint,
  createDiffToolPersistedReviewStateDocument,
  type DiffToolReviewStateStorage,
  parseDiffToolPersistedReviewStateDocument,
} from "./review_state_persistence.js";
import type {
  DiffToolBootstrapPayload,
  DiffToolCodeTheme,
  DiffToolCreateThreadPayload,
  DiffToolCreateThreadResponse,
  DiffToolGetDiffResult,
  DiffToolGuideCommentPayload,
  DiffToolGuideOperation,
  DiffToolReviewState,
  DiffToolStatePatch,
} from "./shared_types.js";
import {
  DIFF_TOOL_CODE_THEMES,
  DIFF_TOOL_GUIDE_QUESTION_LIMIT,
  DIFF_TOOL_GUIDE_TOPIC_LIMIT,
} from "./shared_types.js";

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

export type DiffToolReviewSubmission = DiffReviewSubmission & {
  context: DiffReviewSessionContextResult;
  files: DiffReviewFile[];
};

export type StartDiffToolHttpServerOptions = {
  client: DiffReviewProtocolClient;
  codeTheme?: DiffToolCodeTheme;
  host?: string;
  port?: number;
  storage?: DiffToolReviewStateStorage;
  onSubmit?: (submission: DiffToolReviewSubmission) => Promise<void>;
};

export type StartedDiffToolHttpServer = {
  url: string;
};

type ReviewStatePersistence = {
  storage: DiffToolReviewStateStorage;
  scopeFingerprint: string;
};

type GuideOperationResult = {
  applied: boolean;
  state: DiffToolReviewState;
};

type QueuedGuideOperation = {
  operation: DiffToolGuideOperation;
  resolve: (result: GuideOperationResult) => void;
  reject: (error: unknown) => void;
};

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const DIFF_REVIEW_FORK_REASONING = "medium" as const;

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
  private readonly storage?: DiffToolReviewStateStorage;
  private readonly onSubmit?: (submission: DiffToolReviewSubmission) => Promise<void>;
  private context?: DiffReviewSessionContextResult;
  private files: DiffReviewFile[] = [];
  private persistence?: ReviewStatePersistence;
  private stateMutationQueue: Promise<void> = Promise.resolve();
  private submissionState: "active" | "submitting" | "submitted" = "active";
  private bootstrapThreadPromise?: Promise<string>;
  private guideGenerationPromise?: Promise<DiffToolReviewState>;
  private guideOperationQueue: QueuedGuideOperation[] = [];
  private guideOperationRunning = false;
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
    this.storage = options.storage;
    this.onSubmit = options.onSubmit;
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
      if (this.storage) {
        const diff = await this.client.getDiff();
        const persistence = {
          storage: this.storage,
          scopeFingerprint: createDiffReviewScopeFingerprint(this.context, this.files, diff.patch),
        };
        await this.restoreReviewState(persistence);
        this.persistence = persistence;
      }

      if (this.closed || this.sessionClosing) {
        throw new Error("diff tool session closed during startup");
      }
      await this.listen();
      const address = this.server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to start diff tool http server");
      }

      const url = `http://${formatHttpUrlHost(this.host)}:${String(address.port)}/`;
      await this.client.setUiText({ text: url });
      void this.startBootstrapThread().catch(() => {});
      void this.startGuideGeneration().catch(() => {});

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

  private async restoreReviewState(persistence: ReviewStatePersistence): Promise<void> {
    const document = await persistence.storage.load();
    if (document !== undefined) {
      this.reviewState.replaceState(
        parseDiffToolPersistedReviewStateDocument(document, persistence.scopeFingerprint),
      );
      return;
    }
    await this.persistReviewState(this.reviewState.getState(), persistence);
  }

  private async persistReviewState(
    state: DiffToolReviewState,
    persistence = this.persistence,
  ): Promise<void> {
    if (!persistence) return;
    await persistence.storage.save(
      createDiffToolPersistedReviewStateDocument(persistence.scopeFingerprint, state),
    );
  }

  private async mutateReviewState<T>(
    mutation: (state: DiffToolReviewStateStore) => T,
    isApplied: (result: T) => boolean = () => true,
  ): Promise<{ result: T; state: DiffToolReviewState }> {
    const operation = this.stateMutationQueue.then(async () => {
      const previousState = this.reviewState.getState();
      const draft = this.reviewState.clone();
      const result = mutation(draft);
      if (!isApplied(result)) {
        return { result, state: previousState };
      }

      const nextState = draft.getState();
      await this.persistReviewState(nextState);
      this.reviewState.replaceStatePreservingConcurrentLoading(nextState, previousState);
      return { result, state: this.reviewState.getState() };
    });
    this.stateMutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        if (this.closed || this.sessionClosing) {
          void this.closeHttpServer().then(
            () => reject(new Error("diff tool session closed during startup")),
            reject,
          );
          return;
        }
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

  private startGuideGeneration(): Promise<DiffToolReviewState> {
    if (this.guideGenerationPromise) {
      return this.guideGenerationPromise;
    }

    const currentState = this.reviewState.getState();
    if (currentState.guide.orientation.trim()) {
      return Promise.resolve(currentState);
    }
    if (this.closed) {
      return Promise.reject(new Error("diff tool http server is closed"));
    }

    this.reviewState.setGuideLoading(true);
    const promise = this.generateGuide()
      .catch((error) => {
        this.reviewState.setGuideLoading(false);
        throw error;
      })
      .finally(() => {
        if (this.guideGenerationPromise === promise) {
          this.guideGenerationPromise = undefined;
        }
      });
    this.guideGenerationPromise = promise;
    void promise.catch(() => {});
    return promise;
  }

  private async generateGuide(): Promise<DiffToolReviewState> {
    const result = await this.client.submitThreadMessage({
      forkFromThreadId: await this.getBootstrapThreadId(),
      message: buildDiffReviewGuidePrompt(),
      reasoning: DIFF_REVIEW_FORK_REASONING,
    });
    const guide = parseDiffReviewGuideResponse(result.response);
    const { state } = await this.mutateReviewState((draft) =>
      draft.applyGuideResult(result, guide),
    );
    return state;
  }

  private enqueueGuideOperation(operation: DiffToolGuideOperation): Promise<GuideOperationResult> {
    this.reviewState.setGuideLoading(true);
    const queued = new Promise<GuideOperationResult>((resolve, reject) => {
      this.guideOperationQueue.push({ operation, resolve, reject });
    });
    void this.drainGuideOperationQueue();
    return queued;
  }

  private async drainGuideOperationQueue(): Promise<void> {
    if (this.guideOperationRunning) {
      return;
    }

    this.guideOperationRunning = true;
    try {
      if (this.guideGenerationPromise) {
        await this.guideGenerationPromise;
      }
      while (this.guideOperationQueue.length > 0) {
        const queued = this.guideOperationQueue.splice(0);
        try {
          const result = await this.runGuideOperations(queued.map((entry) => entry.operation));
          for (const entry of queued) {
            entry.resolve(result);
          }
        } catch (error) {
          this.reviewState.setGuideLoading(false);
          for (const entry of queued) {
            entry.reject(error);
          }
        }
      }
    } catch (error) {
      this.reviewState.setGuideLoading(false);
      for (const entry of this.guideOperationQueue.splice(0)) {
        entry.reject(error);
      }
    } finally {
      this.guideOperationRunning = false;
      if (this.guideOperationQueue.length > 0) {
        void this.drainGuideOperationQueue();
      }
    }
  }

  private async runGuideOperations(
    operations: DiffToolGuideOperation[],
  ): Promise<GuideOperationResult> {
    const currentGuide = this.reviewState.getState().guide;
    this.reviewState.setGuideLoading(true);
    const message = buildDiffReviewGuideOperationsPrompt(operations, currentGuide);
    const result = await this.client.submitThreadMessage(
      currentGuide.threadId
        ? { threadId: currentGuide.threadId, message }
        : {
            forkFromThreadId: await this.getBootstrapThreadId(),
            message,
            reasoning: DIFF_REVIEW_FORK_REASONING,
          },
    );
    const contents = parseDiffReviewGuideOperationsResponse(operations, result.response);
    const { result: applied, state } = await this.mutateReviewState(
      (draft) => draft.applyGuideOperationResults(result, operations, contents),
      (value) => value,
    );
    if (!applied) {
      this.reviewState.setGuideLoading(false);
      return { applied, state: this.reviewState.getState() };
    }
    return { applied, state };
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
      const { state } = await this.mutateReviewState((draft) => draft.updateState(payload));
      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread") {
      const payload = parseCreateThreadPayload(await this.readJsonBody(request));
      if (!payload) {
        this.sendJson(response, 400, { error: "invalid thread payload" });
        return;
      }

      const { result: threadId, state } = await this.mutateReviewState((draft) =>
        draft.createThread(payload),
      );
      this.sendJson(response, 200, {
        state,
        threadId,
      } satisfies DiffToolCreateThreadResponse);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/reply") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        this.sendJson(response, 400, { error: "reply text is required" });
        return;
      }

      const { result: added, state } = await this.mutateReviewState(
        (draft) => draft.addReply(id, text),
        (result) => result,
      );
      if (!added) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/delete") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const { result: removed, state } = await this.mutateReviewState(
        (draft) => draft.deleteThread(id),
        (result) => result,
      );
      if (!removed) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }

      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread-message/delete") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const messageIndex =
        typeof payload.messageIndex === "number" && Number.isInteger(payload.messageIndex)
          ? payload.messageIndex
          : -1;
      const { result, state } = await this.mutateReviewState(
        (draft) => {
          if (!draft.findThread(id)) return "thread-not-found" as const;
          return draft.deleteThreadMessage(id, messageIndex)
            ? ("removed" as const)
            : ("message-not-found" as const);
        },
        (result) => result === "removed",
      );
      if (result === "thread-not-found") {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      if (result === "message-not-found") {
        this.sendJson(response, 400, { error: "message not found" });
        return;
      }

      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/resolve") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      if (typeof payload.resolved !== "boolean") {
        this.sendJson(response, 400, { error: "resolved flag is required" });
        return;
      }

      const resolved = payload.resolved;
      const { result: updated, state } = await this.mutateReviewState(
        (draft) => draft.setThreadResolved(id, resolved),
        (result) => result,
      );
      if (!updated) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/thread/collapse") {
      const payload = await this.readJsonBody(request);
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      if (typeof payload.collapsed !== "boolean") {
        this.sendJson(response, 400, { error: "collapsed flag is required" });
        return;
      }

      const collapsed = payload.collapsed;
      const { result: updated, state } = await this.mutateReviewState(
        (draft) => draft.setThreadCollapsed(id, collapsed),
        (result) => result,
      );
      if (!updated) {
        this.sendJson(response, 404, { error: "thread not found" });
        return;
      }
      this.sendJson(response, 200, { state });
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
      if (thread.loading) {
        this.sendJson(response, 409, { error: "thread message already in progress" });
        return;
      }

      const message = this.reviewState.buildThreadAgentMessage(id);
      if (!message) {
        this.sendJson(response, 400, { error: "thread has no pending user message" });
        return;
      }

      const guideSnapshot =
        !thread.threadId &&
        thread.anchor.kind === "detached" &&
        !thread.messages.some((entry) => entry.role === "assistant")
          ? this.reviewState.getState().guide
          : undefined;

      this.reviewState.setThreadLoading(id, true);
      try {
        const result = await this.client.submitThreadMessage(
          thread.threadId
            ? { threadId: thread.threadId, message }
            : {
                forkFromThreadId: await this.getBootstrapThreadId(),
                message: buildDiffReviewCommentThreadPrompt(message, guideSnapshot),
                reasoning: DIFF_REVIEW_FORK_REASONING,
              },
        );
        const { result: applied, state } = await this.mutateReviewState(
          (draft) => draft.applyThreadResponse(id, result),
          (result) => result,
        );
        if (!applied) {
          this.sendJson(response, 404, { error: "thread not found" });
          return;
        }
        this.sendJson(response, 200, { state });
      } catch (error) {
        this.reviewState.setThreadLoading(id, false);
        throw error;
      }
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/guide/generate") {
      const state = await this.startGuideGeneration();
      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/guide/operate") {
      const operation = parseGuideOperation(await this.readJsonBody(request));
      if (!operation) {
        this.sendJson(response, 400, { error: "invalid guide operation" });
        return;
      }
      const currentState = this.reviewState.getState();
      if (
        operation.kind === "topic.add" &&
        currentState.guide.topics.length >= DIFF_TOOL_GUIDE_TOPIC_LIMIT
      ) {
        this.sendJson(response, 409, { error: "guide topic limit reached" });
        return;
      }
      if (
        operation.kind === "question.ask" &&
        currentState.guide.questions.length >= DIFF_TOOL_GUIDE_QUESTION_LIMIT
      ) {
        this.sendJson(response, 409, { error: "guide question limit reached" });
        return;
      }
      if (
        operation.kind === "topic.revise" &&
        !currentState.guide.topics.some((topic) => topic.id === operation.topicId)
      ) {
        this.sendJson(response, 404, { error: "guide topic not found" });
        return;
      }

      const { applied, state } = await this.enqueueGuideOperation(operation);
      if (!applied) {
        this.sendJson(response, 409, { error: "guide changed while it was being updated" });
        return;
      }
      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/guide/comment") {
      const payload = parseGuideCommentPayload(await this.readJsonBody(request));
      if (!payload) {
        this.sendJson(response, 400, { error: "invalid guide comment" });
        return;
      }
      const currentState = this.reviewState.getState();
      if (!guideCommentTargetExists(currentState, payload.target)) {
        this.sendJson(response, 404, { error: "guide comment target not found" });
        return;
      }
      const { state } = await this.mutateReviewState((draft) =>
        draft.saveGuideComment(payload.target, payload.body),
      );
      this.sendJson(response, 200, { state });
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/review") {
      await this.readJsonBody(request);
      await this.stateMutationQueue;
      if (this.submissionState !== "active") {
        this.sendJson(response, 409, { error: "diff review has already been submitted" });
        return;
      }

      this.submissionState = "submitting";
      const submission = this.reviewState.buildReviewSubmission();
      const context = this.context;
      if (!context) {
        this.submissionState = "active";
        throw new Error("diff tool session context is unavailable");
      }

      try {
        await this.onSubmit?.({
          ...submission,
          context: { ...context, diffArgs: [...context.diffArgs] },
          files: this.files.map((file) => ({ ...file })),
        });
      } catch (error) {
        this.submissionState = "active";
        throw error;
      }

      this.submissionState = "submitted";
      const result = await this.client.returnReview(submission);
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

function formatHttpUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function parseGuideOperation(payload: Record<string, unknown>): DiffToolGuideOperation | undefined {
  switch (payload.kind) {
    case "topic.add": {
      const request = typeof payload.request === "string" ? payload.request.trim() : "";
      return request ? { kind: payload.kind, request } : undefined;
    }
    case "topic.revise": {
      const topicId = typeof payload.topicId === "string" ? payload.topicId.trim() : "";
      const request = typeof payload.request === "string" ? payload.request.trim() : "";
      return topicId && request ? { kind: payload.kind, topicId, request } : undefined;
    }
    case "question.ask": {
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      return question ? { kind: payload.kind, question } : undefined;
    }
    default:
      return undefined;
  }
}

function parseGuideCommentPayload(
  payload: Record<string, unknown>,
): DiffToolGuideCommentPayload | undefined {
  const body = typeof payload.body === "string" ? payload.body.trim() : undefined;
  const target =
    payload.target && typeof payload.target === "object" && !Array.isArray(payload.target)
      ? (payload.target as Record<string, unknown>)
      : undefined;
  if (body === undefined || !target) {
    return undefined;
  }
  if (target.kind === "orientation") {
    return { body, target: { kind: "orientation" } };
  }
  if (target.kind === "topic" && typeof target.topicId === "string" && target.topicId.trim()) {
    return { body, target: { kind: "topic", topicId: target.topicId.trim() } };
  }
  if (
    target.kind === "question" &&
    typeof target.questionId === "string" &&
    target.questionId.trim()
  ) {
    return { body, target: { kind: "question", questionId: target.questionId.trim() } };
  }
  return undefined;
}

function guideCommentTargetExists(
  state: DiffToolReviewState,
  target: DiffToolGuideCommentPayload["target"],
): boolean {
  switch (target.kind) {
    case "orientation":
      return Boolean(state.guide.orientation);
    case "topic":
      return state.guide.topics.some((topic) => topic.id === target.topicId);
    case "question":
      return state.guide.questions.some((question) => question.id === target.questionId);
  }
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
