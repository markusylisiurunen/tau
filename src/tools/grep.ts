import { spawn } from "node:child_process";
import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { resolveRestrictedPath } from "../utils/restricted_fs.js";
import { truncateMiddleForModel } from "../utils/truncate.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";

export const GREP_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export const GREP_TOOL_MAX_LINES = 4096;
export const GREP_TOOL_MAX_TOKENS = 25000;

export const GREP_DEFAULT_TIMEOUT_MS = 60_000;
export const GREP_KILL_GRACE_MS = 2_000;

const GREP_DESCRIPTION = ["Search the project with ripgrep (rg).", "Runs without a shell."].join(
  " ",
);

const GREP_PATTERN_DESCRIPTION = "Search pattern (ripgrep regex).";
const GREP_PATHS_DESCRIPTION = "Paths to search (files or directories, relative to repo root).";
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

type GrepExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  captureTruncated: boolean;
};

function abortChildProcess(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }

  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, GREP_KILL_GRACE_MS).unref();
}

async function executeGrep(
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
): Promise<GrepExecResult> {
  return new Promise<GrepExecResult>((resolvePromise) => {
    const child = spawn("rg", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let captureBytes = 0;
    let captureTruncated = false;

    const onData = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (captureTruncated) {
        return;
      }

      captureBytes += chunk.length;
      if (captureBytes > GREP_MAX_CAPTURE_BYTES) {
        captureTruncated = true;
        abortChildProcess(child);
        return;
      }

      const text = chunk.toString("utf-8");
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout?.on("data", (chunk) => onData(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onData(chunk as Buffer, "stderr"));

    const timeout = setTimeout(() => {
      captureTruncated = true;
      abortChildProcess(child);
    }, options.timeoutMs);

    const onAbort = () => {
      abortChildProcess(child);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise({ stdout, stderr, exitCode: code, captureTruncated });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise({ stdout: "", stderr: err.message, exitCode: 2, captureTruncated: false });
    });
  });
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

  if (args.exitCode !== null && args.exitCode !== 0 && args.exitCode !== 1) {
    parts.push("", `(exit ${args.exitCode})`);
  }

  return parts.join("\n");
}

export function createGrepToolDefinition(): ToolDefinition {
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
        return blocked("Grep tool error: missing 'pattern' parameter.");
      }

      const { args: baseArgs, paths } = buildGrepArgs(parsed);

      let rootReal = process.cwd();
      const resolvedPaths: string[] = [];

      try {
        for (const p of paths) {
          const resolved = resolveRestrictedPath(p, { mustExist: true });
          rootReal = resolved.rootReal;
          resolvedPaths.push(resolved.relPath);
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`Grep tool failed: ${errorMessage}`);
      }

      const fullArgs = [...baseArgs, "--", parsed.pattern, ...resolvedPaths];

      return {
        kind: "phased",
        startedUiEvent: {
          type: "grep_started",
          toolCallId: toolCall.id,
          pattern: parsed.pattern,
        },
        run: (async () => {
          const { stdout, stderr, exitCode, captureTruncated } = await executeGrep(fullArgs, {
            cwd: rootReal,
            signal,
            timeoutMs: GREP_DEFAULT_TIMEOUT_MS,
          });

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

          const isError = exitCode !== null && exitCode !== 0 && exitCode !== 1;
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
          };

          return { kind: "single", toolResult, uiEvent };
        })(),
      };
    },
  };
}
