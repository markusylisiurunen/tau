import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { DiffToolConfig } from "../config/index.js";
import type {
  DiffReviewBridge,
  DiffReviewBridgeUiState,
  DiffReviewResult,
  DiffReviewSnapshotSource,
  StartedDiffReviewBridge,
} from "../diff_review/index.js";
import { formatDiffReviewScope } from "../diff_review/snapshot.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { buildHeadTailPreviewLines } from "../utils/tool_preview.js";
import { formatZodError } from "../utils/zod.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
  ToolUiText,
} from "./registry.js";
import { isMainToolDispatchContext } from "./registry.js";
import { TOOL_NAME_DIFF_REVIEW } from "./tool_names.js";

export type DiffReviewToolStartSession = (args: {
  source: DiffReviewSnapshotSource;
  diffTool: DiffToolConfig;
  signal: AbortSignal;
}) => Promise<StartedDiffReviewBridge>;

export type DiffReviewToolOptions = {
  getDiffToolConfig: () => DiffToolConfig | undefined;
  startSession: DiffReviewToolStartSession;
};

const DIFF_REVIEW_DESCRIPTION = [
  "Launch an interactive diff review tool for the user and wait for the user to return review feedback.",
  "Use this tool only when the user explicitly asks you to open, run, or start a diff review.",
  "Do not use it for ordinary diff inspection; use read-only shell/file tools for that instead.",
].join(" ");

const DIFF_REVIEW_SOURCE_DESCRIPTION =
  "Review source. Prefer 'git_diff' for normal reviews because the diff is captured directly from git. Use 'patch_files' only when you need more control than git diff args provide, such as selected hunks, a hand-curated subset of a large file, or multiple custom patches.";

const DIFF_REVIEW_ARGS_DESCRIPTION = [
  "Arguments to pass to git diff when source is 'git_diff'. Use [] to review the current working tree.",
  'Common patterns: staged changes ["--staged"], full branch diff against main ["main...HEAD"], path-limited current changes ["--", "path/to/file"], path-limited branch diff ["main...HEAD", "--", "path/to/file"].',
].join(" ");

const DIFF_REVIEW_PATCH_FILES_DESCRIPTION =
  "Patch files to review when source is 'patch_files'. Required for patch_files. Files may be absolute or relative to the current working directory. Each file must contain git unified diff sections with diff --git headers. Use this for selected hunks or custom review scopes. Patch files may be generated in any way as long as they adhere to that format, for example with git commands, by running code that emits a patch, or by manually editing a temporary patch file. One common approach is starting from `git diff main...HEAD -- src/foo.ts > /tmp/foo.patch` and editing it down to the hunks that should be reviewed. Multiple patch files are allowed, for example [`/tmp/parser.patch`, `/tmp/tests.patch`].";

const DIFF_REVIEW_LABEL_DESCRIPTION =
  "Optional human-readable label for patch-file reviews, for example 'selected hunks from src/foo.ts'.";

export const DIFF_REVIEW_TOOL: Tool = {
  name: TOOL_NAME_DIFF_REVIEW,
  description: DIFF_REVIEW_DESCRIPTION,
  parameters: Type.Object(
    {
      source: Type.String({
        description: DIFF_REVIEW_SOURCE_DESCRIPTION,
        enum: ["git_diff", "patch_files"],
      }),
      diffArgs: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: DIFF_REVIEW_ARGS_DESCRIPTION,
        }),
      ),
      patchFiles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: DIFF_REVIEW_PATCH_FILES_DESCRIPTION,
        }),
      ),
      label: Type.Optional(
        Type.String({
          description: DIFF_REVIEW_LABEL_DESCRIPTION,
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

const diffReviewArgsSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("git_diff"),
    diffArgs: z.array(z.string().trim().min(1)).optional().default([]),
    patchFiles: z.array(z.string().trim().min(1)).optional(),
    label: z.string().trim().min(1).optional(),
  }),
  z.object({
    source: z.literal("patch_files"),
    diffArgs: z.array(z.string().trim().min(1)).optional(),
    patchFiles: z.array(z.string().trim().min(1)).min(1),
    label: z.string().trim().min(1).optional(),
  }),
]);

type ParsedDiffReviewArgs =
  | {
      source: "git_diff";
      diffArgs: string[];
      command: string;
    }
  | {
      source: "patch_files";
      patchFiles: string[];
      command: string;
    };

type CancelledDiffReviewResult = Extract<DiffReviewResult, { status: "cancelled" }>;

function parseDiffReviewArgs(
  raw: unknown,
): { ok: true; data: ParsedDiffReviewArgs } | { ok: false; error: string; command: string } {
  const parsed = diffReviewArgsSchema.safeParse(raw);
  const rawRecord = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawDiffArgs = Array.isArray(rawRecord.diffArgs)
    ? rawRecord.diffArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  const rawPatchFiles = Array.isArray(rawRecord.patchFiles)
    ? rawRecord.patchFiles.filter((arg): arg is string => typeof arg === "string")
    : [];
  const command =
    rawRecord.source === "patch_files"
      ? formatPatchFilesScope(
          rawPatchFiles,
          typeof rawRecord.label === "string" ? rawRecord.label : undefined,
        )
      : formatDiffReviewScope(rawDiffArgs);

  if (!parsed.success) {
    return {
      ok: false,
      error: formatZodError(parsed.error),
      command,
    };
  }

  if (parsed.data.source === "git_diff") {
    return {
      ok: true,
      data: {
        source: "git_diff",
        diffArgs: parsed.data.diffArgs,
        command: formatDiffReviewScope(parsed.data.diffArgs),
      },
    };
  }

  return {
    ok: true,
    data: {
      source: "patch_files",
      patchFiles: parsed.data.patchFiles,
      command: formatPatchFilesScope(parsed.data.patchFiles, parsed.data.label),
    },
  };
}

function formatPatchFilesScope(patchFiles: string[], label?: string): string {
  const trimmedLabel = label?.trim();
  if (trimmedLabel) {
    return trimmedLabel;
  }
  if (patchFiles.length === 1) {
    return `patch file ${patchFiles[0]}`;
  }
  return `${patchFiles.length} patch files`;
}

class ToolUiEventQueue implements AsyncIterable<ToolUiEvent> {
  private pending: ToolUiEvent[] = [];
  private waiters: Array<(result: IteratorResult<ToolUiEvent>) => void> = [];
  private closed = false;

  push(event: ToolUiEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.pending.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ToolUiEvent> {
    return {
      next: async () => {
        const event = this.pending.shift();
        if (event) {
          return { value: event, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<ToolUiEvent>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

function cloneReviewAgents(
  reviewAgents: DiffReviewBridgeUiState["reviewAgents"],
): DiffReviewBridgeUiState["reviewAgents"] {
  return reviewAgents.map((agent) => ({
    ...agent,
    usage: { ...agent.usage },
  }));
}

function createUpdateEvent(args: {
  toolCallId: string;
  command: string;
  uiState: DiffReviewBridgeUiState;
  reviewedFiles: string[];
}): ToolUiEvent {
  return {
    type: "diff_review_updated",
    toolCallId: args.toolCallId,
    command: args.command,
    headerTarget: args.command,
    reviewedFiles: [...args.reviewedFiles],
    ...(args.uiState.diffToolUiText ? { diffToolUiText: args.uiState.diffToolUiText } : {}),
    reviewAgents: cloneReviewAgents(args.uiState.reviewAgents),
  };
}

function createFinishedEvent(args: {
  toolCallId: string;
  command: string;
  status: "success" | "cancelled" | "error";
  uiState?: DiffReviewBridgeUiState;
  reviewedFiles: string[];
  message?: string;
  uiText?: ToolUiText;
}): ToolUiEvent {
  return {
    type: "diff_review_finished",
    toolCallId: args.toolCallId,
    command: args.command,
    headerTarget: args.command,
    status: args.status,
    reviewedFiles: [...args.reviewedFiles],
    ...(args.uiState?.diffToolUiText ? { diffToolUiText: args.uiState.diffToolUiText } : {}),
    reviewAgents: args.uiState ? cloneReviewAgents(args.uiState.reviewAgents) : [],
    ...(args.message ? { message: args.message } : {}),
    ...(args.uiText ? { uiText: args.uiText } : {}),
  };
}

function getReviewedFiles(bridge: DiffReviewBridge): string[] {
  return bridge.snapshot.files.map((file) => file.path);
}

function formatReviewedFiles(files: string[]): string[] {
  return files.length > 0
    ? ["Reviewed files:", ...files.map((file) => `- ${file}`)]
    : ["Reviewed files: (none)"];
}

function formatReturnedReviewToolResult(args: {
  command: string;
  reviewedFiles: string[];
  review: string;
}): string {
  return [
    "Diff review completed.",
    "",
    "The following feedback came from a completed diff review. During that review, the user read through the captured diff snapshot and the files included in it, and may have left comments on specific files, lines, or broader concerns they noticed while reviewing.",
    "",
    `Reviewed scope: ${args.command}`,
    ...formatReviewedFiles(args.reviewedFiles),
    "",
    "Treat the returned review as feedback on that reviewed diff snapshot. Address valid issues directly, clarify anything that seems mistaken or ambiguous, and do not treat it as a new unrelated request.",
    "",
    "Review:",
    args.review,
  ].join("\n");
}

function buildDiffReviewResultUiText(args: { content: string; statusLine: string }): ToolUiText {
  const previewLines = buildHeadTailPreviewLines(args.content, { headLines: 8, tailLines: 8 }).map(
    (text) => ({ text }),
  );
  const fullLines = args.content.split("\n").map((text) => ({ text }));
  return {
    previewLines,
    statusLine: args.statusLine,
    fullLines,
  };
}

function formatCancelledReviewToolResult(result: CancelledDiffReviewResult): string {
  switch (result.reason) {
    case "tool_cancelled":
      return "Diff review cancelled by the diff review tool.";
    case "tool_disconnected":
      return "Diff review cancelled because the diff review tool disconnected or never connected before returning a review.";
    case "controller_cancelled":
      return "Diff review cancelled.";
    case "launch_failed":
      return "Diff review cancelled because the diff review tool failed to launch.";
  }
}

function createBlockedResult(
  toolCall: ToolCall,
  command: string,
  reason: string,
): ToolDispatchResult {
  return {
    kind: "single",
    toolResult: createToolError(toolCall, reason),
    uiEvent: {
      type: "diff_review_blocked",
      toolCallId: toolCall.id,
      command,
      headerTarget: command,
      reason,
    },
  };
}

export function createDiffReviewToolDefinition(options?: DiffReviewToolOptions): ToolDefinition {
  return {
    schema: DIFF_REVIEW_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const parsedArgs = parseDiffReviewArgs(toolCall.arguments);
      const command = parsedArgs.ok ? parsedArgs.data.command : parsedArgs.command;

      if (!parsedArgs.ok) {
        return createBlockedResult(toolCall, command, `Invalid arguments: ${parsedArgs.error}`);
      }

      if (!isMainToolDispatchContext(context)) {
        return createBlockedResult(
          toolCall,
          command,
          "diff_review is only available to the main assistant, not subagents.",
        );
      }

      if (!options) {
        return createBlockedResult(
          toolCall,
          command,
          "diff_review is not available because this session host did not provide a diff-review launcher.",
        );
      }

      const diffTool = options.getDiffToolConfig();
      if (!diffTool) {
        return createBlockedResult(
          toolCall,
          command,
          "configure diffTool in config.json before using diff_review.",
        );
      }

      const events = new ToolUiEventQueue();

      return {
        kind: "phased",
        startedUiEvent: {
          type: "diff_review_started",
          toolCallId: toolCall.id,
          command,
          headerTarget: command,
        },
        uiEvents: events,
        run: (async (): Promise<ToolDispatchResult> => {
          let bridge: DiffReviewBridge | undefined;
          let removeUiStateListener: (() => void) | undefined;
          let abortListener: (() => void) | undefined;
          let reviewedFiles: string[] = [];

          try {
            const source: DiffReviewSnapshotSource =
              parsedArgs.data.source === "git_diff"
                ? { kind: "git_diff", diffArgs: parsedArgs.data.diffArgs }
                : {
                    kind: "patch_files",
                    patchFiles: parsedArgs.data.patchFiles,
                    scopeLabel: parsedArgs.data.command,
                  };
            const started = await options.startSession({
              source,
              diffTool,
              signal,
            });
            const activeBridge = started.bridge;
            bridge = activeBridge;
            reviewedFiles = getReviewedFiles(activeBridge);

            const emitUpdate = (uiState: DiffReviewBridgeUiState) => {
              events.push(
                createUpdateEvent({
                  toolCallId: toolCall.id,
                  command,
                  uiState,
                  reviewedFiles,
                }),
              );
            };

            removeUiStateListener = activeBridge.onUiStateChange(emitUpdate);
            abortListener = () => {
              void activeBridge.cancel("controller_cancelled");
            };
            if (signal.aborted) {
              await activeBridge.cancel("controller_cancelled");
            } else {
              signal.addEventListener("abort", abortListener, { once: true });
            }

            const result = await started.result;
            const uiState = activeBridge.getUiState();

            if (result.status === "returned") {
              const toolText = formatReturnedReviewToolResult({
                command,
                reviewedFiles,
                review: result.review,
              });
              const uiEvent = createFinishedEvent({
                toolCallId: toolCall.id,
                command,
                status: "success",
                uiState,
                reviewedFiles,
                message: "diff review returned feedback.",
                uiText: buildDiffReviewResultUiText({
                  content: toolText,
                  statusLine: `success · ${reviewedFiles.length} reviewed file${reviewedFiles.length === 1 ? "" : "s"}`,
                }),
              });
              const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, false);
              return { kind: "single", toolResult, uiEvent };
            }

            const message = formatCancelledReviewToolResult(result);
            const uiEvent = createFinishedEvent({
              toolCallId: toolCall.id,
              command,
              status: "cancelled",
              uiState,
              reviewedFiles,
              message,
              uiText: buildDiffReviewResultUiText({
                content: message,
                statusLine: `cancelled · ${reviewedFiles.length} reviewed file${reviewedFiles.length === 1 ? "" : "s"}`,
              }),
            });
            return { kind: "single", toolResult: createToolError(toolCall, message), uiEvent };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const message = `Diff review failed: ${errorMessage}`;
            const status = signal.aborted ? "cancelled" : "error";
            const uiEvent = createFinishedEvent({
              toolCallId: toolCall.id,
              command,
              status,
              uiState: bridge?.getUiState(),
              reviewedFiles,
              message,
              uiText: buildDiffReviewResultUiText({
                content: message,
                statusLine: `${status} · ${reviewedFiles.length} reviewed file${reviewedFiles.length === 1 ? "" : "s"}`,
              }),
            });
            return { kind: "single", toolResult: createToolError(toolCall, message), uiEvent };
          } finally {
            if (abortListener) {
              signal.removeEventListener("abort", abortListener);
            }
            removeUiStateListener?.();
            events.close();
          }
        })(),
      };
    },
  };
}
