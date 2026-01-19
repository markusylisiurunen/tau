import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  applyPreviewPolicy,
  buildCompactPreviewLines,
  GREP_UI_MAX_LINES,
  GREP_UI_MAX_TOKENS,
} from "../utils/tool_preview.js";
import { truncateMiddleForModel } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
} from "./registry.js";

export const GREP_TOOL_MAX_LINES = 4096;
export const GREP_TOOL_MAX_TOKENS = 25000;

export const GREP_DEFAULT_TIMEOUT_MS = 60_000;

const GREP_DESCRIPTION = ["Search the project with ripgrep (rg).", "Runs without a shell."].join(
  " ",
);

const GREP_PATTERN_DESCRIPTION = "Search pattern (ripgrep regex).";
const GREP_PATHS_DESCRIPTION =
  "Paths to search (files or directories, relative to the current working directory).";
const GREP_CASE_MODE_DESCRIPTION =
  "Case sensitivity mode. Must be one of: smart, sensitive, insensitive.";
const GREP_FIXED_STRINGS_DESCRIPTION = "Treat pattern as a literal string.";
const GREP_WORD_REGEXP_DESCRIPTION = "Match only whole words.";
const GREP_MAX_COUNT_DESCRIPTION = "Max matches per file.";
const GREP_BEFORE_CONTEXT_DESCRIPTION = "Lines of context before.";
const GREP_AFTER_CONTEXT_DESCRIPTION = "Lines of context after.";
const GREP_CONTEXT_DESCRIPTION = "Lines of context before and after.";
const GREP_GLOB_DESCRIPTION = "Include/exclude glob(s) passed via --glob.";
const GREP_HIDDEN_DESCRIPTION = "Search hidden files and directories.";

export const GREP_TOOL: Tool = {
  name: "grep",
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
  pattern: string;
  paths: string[];
  stdout: ReturnType<typeof truncateMiddleForModel>;
  stderr: ReturnType<typeof truncateMiddleForModel>;
  exitCode: number | null;
  captureTruncated: boolean;
}): string {
  const parts: string[] = [];
  const pathsStr = args.paths.length ? ` ${args.paths.join(" ")}` : "";
  parts.push(`grep ${args.pattern}${pathsStr}`);

  const out = args.stdout.content.trimEnd();
  if (out) {
    parts.push("", out);
  }

  const err = args.stderr.content.trimEnd();
  if (err) {
    parts.push("", "stderr:", err);
  }

  if (args.captureTruncated || args.stdout.truncated || args.stderr.truncated) {
    const shown = `${args.stdout.outputLines} of ${args.stdout.totalLines} lines`;
    parts.push("", `truncated for model: ${shown}`);
  }

  if (args.exitCode === null) {
    parts.push("", "(terminated)");
  } else if (args.exitCode !== 0 && args.exitCode !== 1) {
    parts.push("", `(exit ${args.exitCode})`);
  }

  return parts.join("\n");
}

function buildGrepUiText(args: {
  stdout: string;
  stderr: string;
  stdoutModel: ReturnType<typeof truncateMiddleForModel>;
  stderrModel: ReturnType<typeof truncateMiddleForModel>;
  exitCode: number | null;
  captureTruncated: boolean;
}): ToolUiText {
  const { stdout, stderr, stdoutModel, stderrModel, exitCode, captureTruncated } = args;

  const { truncation: stdoutPreview, previewLines: stdoutLines } = applyPreviewPolicy(
    stdoutModel.content,
    {
      maxLines: GREP_UI_MAX_LINES,
      maxTokens: GREP_UI_MAX_TOKENS,
      strategy: "middle",
    },
  );
  const { truncation: stderrPreview, previewLines: stderrLines } = applyPreviewPolicy(
    stderrModel.content,
    {
      maxLines: GREP_UI_MAX_LINES,
      maxTokens: GREP_UI_MAX_TOKENS,
      strategy: "middle",
    },
  );

  const err = stderrPreview.content.trimEnd();
  const out = stdoutPreview.content.trimEnd();
  const previewText = err
    ? (buildCompactPreviewLines(stderrLines, {
        totalLines: stderrPreview.totalLines,
        maxLines: 16,
      }) ?? "")
    : out
      ? (buildCompactPreviewLines(stdoutLines, {
          totalLines: stdoutPreview.totalLines,
          maxLines: 16,
        }) ?? "")
      : "";

  const previewLines: ToolUiLine[] = previewText
    ? previewText.split("\n").map((text) => ({ text }))
    : [];

  const fullLines: ToolUiLine[] = [];
  const pushSection = (text: string): void => {
    if (!text) return;
    if (fullLines.length > 0) {
      fullLines.push({ text: "" });
    }
    for (const line of text.split("\n")) {
      fullLines.push({ text: line });
    }
  };

  const trimmedOut = stdout.trimEnd();
  if (trimmedOut) {
    pushSection(trimmedOut);
  }
  const trimmedErr = stderr.trimEnd();
  if (trimmedErr) {
    pushSection(["stderr:", trimmedErr].join("\n"));
  }

  if (stdoutModel.truncated || stderrModel.truncated || captureTruncated) {
    pushSection(
      `truncated for model: ${stdoutModel.outputLines} of ${stdoutModel.totalLines} lines`,
    );
  }

  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
    pushSection(`(exit ${exitCode})`);
  }

  return {
    previewLines,
    fullLines,
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

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "grep_blocked",
          toolCallId: toolCall.id,
          pattern: parsed.pattern || "(missing pattern)",
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

          const { stdout, stderr, exitCode, captureTruncated, resolvedPaths } = result;

          const stdoutModel = truncateMiddleForModel(stdout, {
            maxLines: GREP_TOOL_MAX_LINES,
            maxTokens: GREP_TOOL_MAX_TOKENS,
          });
          const stderrModel = truncateMiddleForModel(stderr, {
            maxLines: GREP_TOOL_MAX_LINES,
            maxTokens: GREP_TOOL_MAX_TOKENS,
          });

          const toolText = formatGrepToolResultText({
            pattern: parsed.pattern,
            paths: resolvedPaths,
            stdout: stdoutModel,
            stderr: stderrModel,
            exitCode,
            captureTruncated,
          });
          const uiText = buildGrepUiText({
            stdout,
            stderr,
            stdoutModel,
            stderrModel,
            exitCode,
            captureTruncated,
          });

          const isError = exitCode === null || (exitCode !== 0 && exitCode !== 1);
          const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);

          const uiEvent: ToolUiEvent = {
            type: "grep_finished",
            toolCallId: toolCall.id,
            pattern: parsed.pattern,
            status: isError ? "error" : "success",
            exitCode,
            stdout: stdoutModel.content,
            stderr: stderrModel.content,
            captureTruncated,
            uiText,
          };

          return { kind: "single", toolResult, uiEvent };
        })(),
      };
    },
  };
}
