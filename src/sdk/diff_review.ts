import { DiffReviewBridge } from "../core/diff_review/bridge.js";
import { buildDiffReviewInstructions } from "../core/diff_review/review_instructions.js";
import { captureDiffReviewSnapshot } from "../core/diff_review/snapshot.js";
import { DiffToolHttpServer } from "../diff_tool/http_server.js";
import {
  DiffReviewProtocolClient,
  parseDiffToolLaunchEnvironment,
} from "../diff_tool/protocol_client.js";
import {
  createSdkDiffSnapshotDeps,
  createSdkToolExecutionBackend,
} from "./session_tool_execution_backend.js";
import type { TauSdkSession } from "./types.js";

export type TauSdkDiffReviewSource =
  | {
      kind: "git_diff";
      diffArgs: string[];
    }
  | {
      kind: "patch_files";
      patchFiles: string[];
      scopeLabel: string;
    };

export type TauSdkDiffReviewResult =
  | {
      status: "returned";
      review: string;
    }
  | {
      status: "cancelled";
      reason: "tool_cancelled" | "tool_disconnected" | "controller_cancelled" | "launch_failed";
    };

export type TauSdkDiffReviewStorage = {
  load(): Promise<unknown | undefined>;
  save(document: unknown): Promise<void>;
};

export type TauSdkDiffReviewSubmission = {
  review: string;
  diffCommand: string;
  reviewedFiles: string[];
};

export type StartTauSdkDiffReviewOptions = {
  session: TauSdkSession;
  source: TauSdkDiffReviewSource;
  host?: string;
  port?: number;
  signal?: AbortSignal;
  storage?: TauSdkDiffReviewStorage;
  onSubmit?: (submission: TauSdkDiffReviewSubmission) => Promise<void>;
};

export type StartedTauSdkDiffReview = {
  url: string;
  result: Promise<TauSdkDiffReviewResult>;
  close(): Promise<void>;
};

export async function startTauSdkDiffReview(
  options: StartTauSdkDiffReviewOptions,
): Promise<StartedTauSdkDiffReview> {
  options.signal?.throwIfAborted();
  const sessionSnapshot = await options.session.snapshot();
  const cwd = sessionSnapshot.executionEnvironment.cwd;
  const backend = createSdkToolExecutionBackend({
    executionEnvironment: options.session,
    cwd,
  });
  const snapshot = await captureDiffReviewSnapshot({
    cwd,
    source: options.source,
    ...(options.signal ? { signal: options.signal } : {}),
    deps: createSdkDiffSnapshotDeps({ backend, cwd }),
  });
  options.signal?.throwIfAborted();

  const ephemeral = await options.session.createEphemeralContext({
    instructions: buildDiffReviewInstructions(snapshot),
    tools: ["bash", "view_image"],
  });
  const bridge = new DiffReviewBridge({
    snapshot,
    contextWindow: sessionSnapshot.bootstrap.model.contextWindow,
    submitThreadMessage: (submitOptions) =>
      options.session.submitEphemeralThread({
        contextId: ephemeral.contextId,
        threadId: submitOptions.threadId,
        ...(submitOptions.forkFromThreadId
          ? { forkFromThreadId: submitOptions.forkFromThreadId }
          : {}),
        message: submitOptions.message,
      }),
  });
  const unsubscribeEphemeral = options.session.onEphemeral((message) => {
    const event = message.event;
    if (event.type !== "ephemeral-agent.thread-update" || event.contextId !== ephemeral.contextId) {
      return;
    }
    bridge.applyThreadUpdate(event.threadId, {
      costTotal: event.update.costTotal,
      usage: { ...event.update.usage },
      ...(event.update.lastActivityText ? { lastActivityText: event.update.lastActivityText } : {}),
    });
  });

  let server: DiffToolHttpServer | undefined;
  let removeAbortListener = (): void => undefined;
  try {
    await bridge.start();
    options.signal?.throwIfAborted();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(bridge.launchEnvironment),
    );
    const onSubmit = options.onSubmit;
    server = new DiffToolHttpServer({
      client,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(onSubmit
        ? {
            onSubmit: async (submission) => {
              await onSubmit({
                review: submission.review,
                diffCommand: submission.context.diffCommand,
                reviewedFiles: submission.files.map((file) => file.path),
              });
            },
          }
        : {}),
    });
    const started = await server.start();
    options.signal?.throwIfAborted();

    const onAbort = () => {
      void bridge.cancel("controller_cancelled");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);

    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      removeAbortListener();
      unsubscribeEphemeral();
      await options.session.closeEphemeralContext(ephemeral.contextId).catch(() => undefined);
      await server?.close().catch(() => undefined);
      await bridge.close().catch(() => undefined);
    };
    const result: Promise<TauSdkDiffReviewResult> = bridge.result.finally(cleanup);

    return {
      url: started.url,
      result,
      async close() {
        await bridge.cancel("controller_cancelled");
        await result;
      },
    };
  } catch (error) {
    removeAbortListener();
    unsubscribeEphemeral();
    await server?.close().catch(() => undefined);
    await bridge.cancel("launch_failed").catch(() => undefined);
    await bridge.close().catch(() => undefined);
    await options.session.closeEphemeralContext(ephemeral.contextId).catch(() => undefined);
    throw error;
  }
}
