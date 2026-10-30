import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { formatCwd } from "../utils/format.js";
import { formatTokenEstimate } from "../utils/token.js";
import { TRUNCATION_MARKER } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import { buildToolRunPresentation, formatToolDurationMs } from "./presentation.js";
import { type AgentTool, createTextToolOutcome, executeTool } from "./registry.js";

export const MAX_JOBS = 64;
export const JOB_WAIT_DEFAULT_MS = 60_000;
export const JOB_WAIT_MAX_MS = 300_000;

export async function waitForJobs(
  jobs: readonly { done: Promise<void> }[],
  timeout: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > JOB_WAIT_MAX_MS)
    throw new Error(`timeout must be a positive integer up to ${JOB_WAIT_MAX_MS}.`);
  if (!jobs.length) throw new Error("ids must not be empty.");
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    return await Promise.race([
      ...jobs.map((job) => job.done.then(() => false)),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeout);
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function buildJobMetadata(args: {
  text: string;
  durationMs: number;
  truncated?: boolean;
  timedOut?: boolean;
  workingDirectory?: string;
}): string[] {
  const lines = args.text.split("\n").length;
  return [
    ...(args.truncated ? [TRUNCATION_MARKER] : []),
    ...(args.workingDirectory ? [formatCwd(args.workingDirectory)] : []),
    formatToolDurationMs(args.durationMs),
    formatTokenEstimate(Buffer.byteLength(args.text, "utf8")),
    `${lines} line${lines === 1 ? "" : "s"}`,
    ...(args.timedOut ? ["timed out"] : []),
  ];
}

function buildJobPresentation(
  kind: "bash" | "code",
  toolName: string,
  args: { id?: string; ids?: string[] } | undefined,
  text?: string,
  metadata?: string[],
) {
  const detailText = text?.replace(/\r\n?/g, "\n").trimEnd();
  return buildToolRunPresentation({
    toolName,
    operation: kind,
    subject: args ? (args.ids?.join(", ") ?? args.id ?? "jobs") : "(invalid arguments)",
    details: detailText ? detailText.split("\n").map((text) => ({ text })) : [],
    metadata,
  });
}

export interface BackgroundJobTools {
  inspect(
    ids?: string[],
    includeOutput?: boolean,
    maxOutputTokens?: number,
  ): Promise<{
    text: string;
    truncated: boolean;
    content?: Array<TextContent | ImageContent>;
  }>;
  stopJob(id: string): Promise<void>;
  waitJobs(ids: string[], timeout: number, signal: AbortSignal): Promise<boolean>;
}

export function createJobToolDefinitions(
  jobs: BackgroundJobTools,
  kind: "bash" | "code",
): AgentTool[] {
  const label = kind === "bash" ? "Bash" : "code";
  const id = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });
  const idSchema = z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/);
  const includeOutput = Type.Optional(
    Type.Boolean({
      description:
        "Include captured output; defaults to true. Set false to return only job metadata. Error details are part of the output, so they are omitted too.",
    }),
  );
  const maxOutputTokens = Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 65536,
      description:
        "Maximum estimated tokens of output text for the whole response, divided evenly among the requested jobs. Defaults to 8192. Increase it when you need more output, up to 65536, or read the reported text log.",
    }),
  );
  const outputTokensSchema = z.number().int().min(1).max(65536).optional();
  return [
    {
      name: `list_${kind}_jobs`,
      description: `List your ${label} jobs and their status, without output. Up to 64 records are retained; older completed jobs are evicted when needed.`,
      parameters: Type.Object({}, { additionalProperties: false }),
      parser: z.object({}).strict(),
    },
    {
      name: `read_${kind}_job`,
      description: `Read a ${label} job's current status and captured output without waiting. Long output is shortened to its beginning and end. After the job finishes, the result reports a text log with all retained text; read that file instead of rerunning the job.`,
      parameters: Type.Object(
        { id, includeOutput, maxOutputTokens },
        { additionalProperties: false },
      ),
      parser: z
        .object({
          id: idSchema,
          includeOutput: z.boolean().optional(),
          maxOutputTokens: outputTokensSchema,
        })
        .strict(),
    },
    {
      name: `stop_${kind}_job`,
      description:
        kind === "bash"
          ? "Stop a Bash job and its process group, escalating to forced termination if needed. Waits until the job has stopped and returns its final record."
          : "Stop a code job and its in-flight capability calls. Bash jobs the program started keep running. Waits until the code job has stopped and returns its final record.",
      parameters: Type.Object(
        { id, includeOutput, maxOutputTokens },
        { additionalProperties: false },
      ),
      parser: z
        .object({
          id: idSchema,
          includeOutput: z.boolean().optional(),
          maxOutputTokens: outputTokensSchema,
        })
        .strict(),
    },
    {
      name: `wait_for_${kind}_jobs`,
      description: `Wait until any requested ${label} job finishes. Returns after 60 seconds by default, at most 5 minutes. Timeout and interruption cancel only the wait, not jobs. Completed results remain readable.`,
      parameters: Type.Object(
        {
          includeOutput,
          maxOutputTokens,
          ids: Type.Array(id, { minItems: 1, maxItems: MAX_JOBS }),
          timeout: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: JOB_WAIT_MAX_MS,
              description: "Wait timeout in milliseconds; defaults to 60000.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      parser: z
        .object({
          includeOutput: z.boolean().optional(),
          maxOutputTokens: outputTokensSchema,
          ids: z.array(idSchema).min(1).max(MAX_JOBS),
          timeout: z.number().int().positive().max(JOB_WAIT_MAX_MS).optional(),
        })
        .strict(),
    },
  ].map(
    ({ parser, ...schema }): AgentTool => ({
      schema,
      describe: (call) => {
        const parsed = parser.safeParse(call.arguments);
        return {
          presentation: buildJobPresentation(
            kind,
            schema.name,
            parsed.success ? parsed.data : undefined,
          ),
        };
      },
      execute: (call, context) =>
        executeTool(context, async () => {
          const startedAt = Date.now();
          const parsed = parser.safeParse(call.arguments);
          if (!parsed.success) {
            const reason = `Invalid arguments: ${formatZodError(parsed.error)}`;
            return {
              ...createTextToolOutcome(reason, "blocked"),
              uiEvent: {
                type: "tool_call_blocked" as const,
                toolCallId: call.id,
                toolName: schema.name,
                reason,
                presentation: buildJobPresentation(kind, schema.name, undefined, reason),
              },
            };
          }
          const args = parsed.data;
          try {
            context.signal.throwIfAborted();
            let timedOut = false;
            if ("ids" in args)
              timedOut = await jobs.waitJobs(
                args.ids,
                args.timeout ?? JOB_WAIT_DEFAULT_MS,
                context.signal,
              );
            else if ("id" in args && schema.name === `stop_${kind}_job`)
              await jobs.stopJob(args.id);
            const result = await jobs.inspect(
              "ids" in args ? args.ids : "id" in args ? [args.id] : undefined,
              "id" in args || "ids" in args ? (args.includeOutput ?? true) : false,
              "maxOutputTokens" in args ? args.maxOutputTokens : undefined,
            );
            if (timedOut) {
              const note = `Wait timed out after ${"timeout" in args ? (args.timeout ?? JOB_WAIT_DEFAULT_MS) : JOB_WAIT_DEFAULT_MS}ms; jobs are still running.\n\n`;
              result.text = note + result.text;
              if (result.content) result.content.unshift({ type: "text", text: note });
            }
            const { text } = result;
            return {
              ...createTextToolOutcome(text, "succeeded"),
              ...(result.content ? { content: result.content } : {}),
              uiEvent: {
                type: "tool_call_finished" as const,
                toolCallId: call.id,
                toolName: schema.name,
                status: "success" as const,
                presentation: buildJobPresentation(
                  kind,
                  schema.name,
                  args,
                  text,
                  buildJobMetadata({
                    ...result,
                    timedOut,
                    durationMs: Math.max(0, Date.now() - startedAt),
                  }),
                ),
              },
            };
          } catch (error) {
            const reason = context.signal.aborted
              ? `${kind === "bash" ? "Bash" : "Code"} job operation was cancelled.`
              : error instanceof Error
                ? error.message
                : String(error);
            return {
              ...createTextToolOutcome(reason, context.signal.aborted ? "cancelled" : "failed"),
              uiEvent: {
                type: "tool_call_finished" as const,
                toolCallId: call.id,
                toolName: schema.name,
                status: "error" as const,
                presentation: buildJobPresentation(
                  kind,
                  schema.name,
                  args,
                  context.signal.aborted ? undefined : reason,
                ),
              },
            };
          }
        }),
    }),
  );
}
