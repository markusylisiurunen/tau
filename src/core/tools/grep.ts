import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { buildHeadTailPreviewLines } from "../utils/tool_preview.js";
import { TRUNCATION_MARKER, type TruncationResult, truncateForTokens } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
} from "./registry.js";
import { TOOL_NAME_GREP } from "./tool_names.js";

export const GREP_TOOL_MAX_TOKENS = 8192;

export const GREP_DEFAULT_TIMEOUT_MS = 60_000;

const GREP_DESCRIPTION = [
  "Search files with ripgrep (rg) without a shell.",
  "Supports regex, globs, and context lines.",
  "Prefer this over bash rg when available for consistent output.",
].join(" ");

const GREP_PATTERN_DESCRIPTION =
  "Search pattern. Regex by default, use fixedStrings for literal text.";
const GREP_PATHS_DESCRIPTION =
  "Files or directories to search (absolute or relative). Defaults to the current directory.";
const GREP_CASE_MODE_DESCRIPTION = "Case sensitivity: smart (default), sensitive, or insensitive.";
const GREP_FIXED_STRINGS_DESCRIPTION = "Treat the pattern as a literal string (no regex).";
const GREP_WORD_REGEXP_DESCRIPTION = "Match whole words only.";
const GREP_MAX_COUNT_DESCRIPTION = "Maximum matches per file.";
const GREP_BEFORE_CONTEXT_DESCRIPTION = "Lines of context before each match.";
const GREP_AFTER_CONTEXT_DESCRIPTION = "Lines of context after each match.";
const GREP_CONTEXT_DESCRIPTION = "Lines of context before and after each match.";
const GREP_GLOB_DESCRIPTION = "rg --glob pattern(s), use ! to exclude.";
const GREP_HIDDEN_DESCRIPTION = "Include hidden files and directories.";

export const GREP_TOOL: Tool = {
  name: TOOL_NAME_GREP,
  description: GREP_DESCRIPTION,
  parameters: Type.Object(
    {
      pattern: Type.String({ description: GREP_PATTERN_DESCRIPTION }),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: GREP_PATHS_DESCRIPTION,
        }),
      ),
      caseMode: Type.Optional(
        Type.String({
          description: GREP_CASE_MODE_DESCRIPTION,
          enum: ["smart", "sensitive", "insensitive"],
        }),
      ),
      fixedStrings: Type.Optional(Type.Boolean({ description: GREP_FIXED_STRINGS_DESCRIPTION })),
      wordRegexp: Type.Optional(Type.Boolean({ description: GREP_WORD_REGEXP_DESCRIPTION })),
      maxCount: Type.Optional(
        Type.Integer({ description: GREP_MAX_COUNT_DESCRIPTION, minimum: 1 }),
      ),
      beforeContext: Type.Optional(
        Type.Integer({ description: GREP_BEFORE_CONTEXT_DESCRIPTION, minimum: 0 }),
      ),
      afterContext: Type.Optional(
        Type.Integer({ description: GREP_AFTER_CONTEXT_DESCRIPTION, minimum: 0 }),
      ),
      context: Type.Optional(Type.Integer({ description: GREP_CONTEXT_DESCRIPTION, minimum: 0 })),
      glob: Type.Optional(Type.Array(Type.String(), { description: GREP_GLOB_DESCRIPTION })),
      hidden: Type.Optional(Type.Boolean({ description: GREP_HIDDEN_DESCRIPTION })),
    },
    { additionalProperties: false },
  ),
};

const grepArgsSchema = z.object({
  pattern: z.string().trim().catch(""),
  paths: z.array(z.string().trim()).optional(),
  caseMode: z.enum(["smart", "sensitive", "insensitive"]).optional(),
  fixedStrings: z.boolean().optional(),
  wordRegexp: z.boolean().optional(),
  maxCount: z.number().int().positive().optional(),
  beforeContext: z.number().int().min(0).optional(),
  afterContext: z.number().int().min(0).optional(),
  context: z.number().int().min(0).optional(),
  glob: z.array(z.string()).optional(),
  hidden: z.boolean().optional(),
});

type GrepArgs = {
  pattern: string;
  paths?: string[];
  caseMode?: "smart" | "sensitive" | "insensitive";
  fixedStrings?: boolean;
  wordRegexp?: boolean;
  maxCount?: number;
  beforeContext?: number;
  afterContext?: number;
  context?: number;
  glob?: string[];
  hidden?: boolean;
};

function parseGrepArgs(raw: unknown): GrepArgs {
  const parsed = grepArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { pattern: "" };
}

function buildGrepArgs(raw: z.infer<typeof grepArgsSchema>): {
  args: string[];
  paths: string[];
} {
  const args: string[] = ["--color", "never", "--column", "--with-filename", "--line-number"];

  const caseMode = raw.caseMode ?? "smart";
  if (caseMode === "smart") {
    args.push("--smart-case");
  } else if (caseMode === "insensitive") {
    args.push("-i");
  }

  if (raw.fixedStrings) {
    args.push("--fixed-strings");
  }

  if (raw.wordRegexp) {
    args.push("--word-regexp");
  }

  if (raw.maxCount !== undefined) {
    args.push("--max-count", String(raw.maxCount));
  }

  if (raw.context !== undefined) {
    args.push("-C", String(raw.context));
  } else {
    if (raw.beforeContext !== undefined) {
      args.push("-B", String(raw.beforeContext));
    }
    if (raw.afterContext !== undefined) {
      args.push("-A", String(raw.afterContext));
    }
  }

  if (raw.hidden) {
    args.push("--hidden");
  }

  if (raw.glob) {
    for (const g of raw.glob) {
      const cleaned = g.trim();
      if (!cleaned) continue;
      args.push("--glob", cleaned);
    }
  }

  const paths = raw.paths && raw.paths.length > 0 ? raw.paths : ["."];

  return { args, paths };
}

function formatGrepToolResultText(args: {
  output: TruncationResult;
  exitCode: number | null;
  captureTruncated: boolean;
}): string {
  const parts: string[] = [];

  const out = args.output.content.trimEnd();
  if (out) {
    parts.push(out);
  }

  if (args.captureTruncated || args.output.truncated) {
    if (parts.length > 0) {
      parts.push("");
    }
    const shown = `${args.output.outputLines} of ${args.output.totalLines} lines`;
    parts.push(`truncated for model: ${shown}. narrow the search scope to see more.`);
  }

  if (args.exitCode === null) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push("(terminated)");
  } else if (args.exitCode !== 0 && args.exitCode !== 1) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(`(exit ${args.exitCode})`);
  }

  return parts.join("\n");
}

function buildGrepUiText(args: {
  modelTruncation: TruncationResult;
  fullText: string;
  captureTruncated: boolean;
}): ToolUiText {
  const { modelTruncation, fullText, captureTruncated } = args;

  const previewContentLines = buildHeadTailPreviewLines(modelTruncation.content, {
    headLines: 5,
    tailLines: 5,
  });

  const previewLines: ToolUiLine[] = previewContentLines.map((text) => ({ text }));

  const trimmedFullText = fullText.trimEnd();
  const fullLines: ToolUiLine[] = trimmedFullText
    ? trimmedFullText.split("\n").map((text) => ({ text }))
    : [];

  const statusLine = modelTruncation.truncated || captureTruncated ? TRUNCATION_MARKER : undefined;

  return {
    previewLines,
    fullLines,
    statusLine,
  };
}

export function createGrepToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: GREP_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const parsed = parseGrepArgs(toolCall.arguments);
      const headerTarget = parsed.pattern || "(missing pattern)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "grep_blocked",
          toolCallId: toolCall.id,
          pattern: parsed.pattern || "(missing pattern)",
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!parsed.pattern) {
        return blocked("missing 'pattern' parameter.");
      }

      const { args: baseArgs, paths } = buildGrepArgs(parsed);
      try {
        await backend.grep({
          baseArgs,
          pattern: parsed.pattern,
          paths,
          timeoutMs: GREP_DEFAULT_TIMEOUT_MS,
          dryRun: true,
        });
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`grep failed: ${errorMessage}`);
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "grep_started",
          toolCallId: toolCall.id,
          pattern: parsed.pattern,
          headerTarget,
        },
        run: (async () => {
          let result: Awaited<ReturnType<ToolExecutionBackend["grep"]>>;
          try {
            result = await backend.grep({
              baseArgs,
              pattern: parsed.pattern,
              paths,
              signal,
              timeoutMs: GREP_DEFAULT_TIMEOUT_MS,
            });
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return blocked(`grep failed: ${errorMessage}`);
          }

          const { output, exitCode, captureTruncated } = result;

          const outputModel = truncateForTokens(output, {
            maxTokens: GREP_TOOL_MAX_TOKENS,
            strategy: "head",
          });

          const toolText = formatGrepToolResultText({
            output: outputModel,
            exitCode,
            captureTruncated,
          });
          const uiText = buildGrepUiText({
            modelTruncation: outputModel,
            fullText: toolText,
            captureTruncated,
          });

          const isError = exitCode === null || (exitCode !== 0 && exitCode !== 1);
          const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);

          const uiEvent: ToolUiEvent = {
            type: "grep_finished",
            toolCallId: toolCall.id,
            pattern: parsed.pattern,
            headerTarget,
            status: isError ? "error" : "success",
            exitCode,
            output: outputModel.content,
            captureTruncated,
            uiText,
          };

          return { kind: "single", toolResult, uiEvent };
        })(),
      };
    },
  };
}
