import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { z } from "zod";
import { formatCwd } from "../utils/format.js";
import { formatTokenEstimate } from "../utils/token.js";
import { TRUNCATION_MARKER, truncateForTokens, truncateToBytesFromEnd } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import type { BashExecutionResult, ToolExecutionBackend } from "./execution_backend.js";
import { JobOutput } from "./job_output.js";
import { buildToolRunPresentation, formatToolDurationMs } from "./presentation.js";
import { type AgentTool, createTextToolOutcome, executeTool } from "./registry.js";

const MAX_JOBS = 64;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export const BASH_JOB_WAIT_DEFAULT_MS = 60_000;
export const BASH_JOB_WAIT_MAX_MS = 300_000;

interface BashJob {
  id: string;
  command: string;
  cwd: string;
  output: string;
  log: JobOutput;
  logPath?: string;
  truncated: boolean;
  controller: AbortController;
  done: Promise<void>;
  active: boolean;
  state:
    | { status: "running" }
    | {
        status: "finished";
        result: Pick<BashExecutionResult, "exitCode" | "aborted" | "closeSignal">;
      }
    | { status: "failed"; error: string };
}

export class BashJobRegistry {
  private readonly jobs = new Map<string, BashJob>();
  private closed = false;

  async start(
    backend: ToolExecutionBackend,
    command: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Bash jobs are closed.");
    if (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => !job.active);
      if (!oldest)
        throw new Error(
          `Bash job limit reached (${MAX_JOBS}). Stop a job before starting another.`,
        );
      this.jobs.delete(oldest.id);
    }
    let started!: () => void;
    const launched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const job: BashJob = {
      id: randomUUID(),
      command: truncateForTokens(command, { maxTokens: 128, strategy: "middle" }).content,
      cwd: truncateForTokens(cwd, { maxTokens: 128, strategy: "middle" }).content,
      output: "",
      log: new JobOutput(backend),
      truncated: false,
      controller: new AbortController(),
      done: Promise.resolve(),
      active: true,
      state: { status: "running" },
    };
    this.jobs.set(job.id, job);
    const abortLaunch = () => job.controller.abort();
    signal.addEventListener("abort", abortLaunch, { once: true });
    const decoder = new StringDecoder("utf8");
    job.done = (async () => {
      try {
        const result = await backend.runBash(command, {
          cwd,
          signal: job.controller.signal,
          maxCaptureBytes: MAX_OUTPUT_BYTES,
          onStarted: started,
          onOutput: (chunk) => {
            const text = decoder.write(chunk);
            job.log.capture.appendText(text);
            const output = job.output + text;
            job.truncated ||= Buffer.byteLength(output) > MAX_OUTPUT_BYTES;
            job.output = truncateToBytesFromEnd(output, MAX_OUTPUT_BYTES);
          },
        });
        const tail = decoder.end();
        job.log.capture.appendText(tail);
        job.output = truncateToBytesFromEnd(job.output + tail, MAX_OUTPUT_BYTES);
        job.truncated ||= result.truncated;
        const { exitCode, aborted, closeSignal } = result;
        job.state = { status: "finished", result: { exitCode, aborted, closeSignal } };
      } catch (error) {
        job.log.capture.appendText(`\n${error instanceof Error ? error.message : String(error)}`);
        job.state = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      job.logPath = await job.log.save();
      job.active = false;
    })();
    try {
      await Promise.race([launched, job.done]);
      signal.throwIfAborted();
      if (job.state.status === "failed") throw new Error(job.state.error);
      return job.id;
    } finally {
      signal.removeEventListener("abort", abortLaunch);
    }
  }

  private get(id: string): BashJob {
    const job = this.jobs.get(id);
    if (!job)
      throw new Error(
        `Unknown Bash job '${id}' (jobs are not recovered after restart and older completed records may be evicted).`,
      );
    return job;
  }

  read(ids: string[] = [...this.jobs.keys()], includeOutput = true) {
    return ids.map((id) => {
      const job = this.get(id);
      const state = job.state;
      return {
        id: job.id,
        command: job.command,
        workingDirectory: job.cwd,
        ...(includeOutput ? { output: stripAnsi(job.output) } : {}),
        truncated: job.truncated,
        status:
          state.status === "finished"
            ? state.result.aborted
              ? "stopped"
              : state.result.exitCode === 0
                ? "succeeded"
                : "failed"
            : state.status,
        ...(state.status === "finished" ? state.result : {}),
        ...(includeOutput && state.status === "failed" ? { error: state.error } : {}),
      };
    });
  }

  format(ids: string[] = [...this.jobs.keys()], includeOutput = true, maxOutputTokens = 8192) {
    let truncated = false;
    const text =
      ids
        .map((id) => {
          const job = this.get(id);
          const state = this.read([id], false)[0]!;
          const lines = [
            `id: ${id}`,
            `status: ${state.status}`,
            `command: ${JSON.stringify(job.command)}`,
            `cwd: ${JSON.stringify(job.cwd)}`,
          ];
          if ("exitCode" in state) lines.push(`exit_code: ${state.exitCode ?? "null"}`);
          if ("closeSignal" in state && state.closeSignal)
            lines.push(`signal: ${state.closeSignal}`);
          if (includeOutput) {
            const output =
              job.output + (job.state.status === "failed" ? `\n${job.state.error}` : "");
            const model = truncateForTokens(stripAnsi(output), {
              maxTokens: Math.floor(maxOutputTokens / Math.max(1, ids.length)),
              strategy: "tail",
            });
            truncated ||= model.truncated || job.truncated;
            if (model.truncated) lines.push("output: truncated; showing latest output");
            if (job.truncated)
              lines.push("capture: truncated; earlier text was discarded (1 MiB limit)");
            if (job.logPath) lines.push(`text_log: ${job.logPath}`);
            else if (output) lines.push("text_log: unavailable");
            lines.push("", "--- output ---", model.content);
          }
          return lines.join("\n");
        })
        .join("\n\n") || "No Bash jobs.";
    return { text, truncated };
  }

  async inspect(ids?: string[], includeOutput = true, maxOutputTokens = 8192) {
    if (includeOutput) {
      await Promise.all(
        (ids ?? [...this.jobs.keys()]).map(async (id) => {
          const job = this.get(id);
          job.logPath = await job.log.save();
        }),
      );
    }
    return this.format(ids, includeOutput, maxOutputTokens);
  }

  async stopJob(id: string): Promise<void> {
    const job = this.get(id);
    job.controller.abort();
    await job.done;
    if (job.state.status === "failed") throw new Error(job.state.error);
  }

  async stop(id: string, includeOutput: boolean) {
    await this.stopJob(id);
    return this.format([id], includeOutput);
  }

  async waitJobs(ids: string[], timeout: number, signal: AbortSignal): Promise<boolean> {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > BASH_JOB_WAIT_MAX_MS)
      throw new Error(`timeout must be a positive integer up to ${BASH_JOB_WAIT_MAX_MS}.`);
    const jobs = [...new Set(ids)].map((id) => this.get(id));
    if (!jobs.length) throw new Error("ids must not be empty.");
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    try {
      const timedOut = await Promise.race([
        ...jobs.map((job) => job.done.then(() => false)),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeout);
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      return timedOut;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async wait(ids: string[], timeout: number, signal: AbortSignal, includeOutput: boolean) {
    const timedOut = await this.waitJobs(ids, timeout, signal);
    const result = this.format(ids, includeOutput);
    return {
      ...result,
      text: `${result.text}${timedOut ? `\n\nWait timed out after ${timeout}ms; jobs are still running.` : ""}`,
      timedOut,
    };
  }

  get hasRunning(): boolean {
    return [...this.jobs.values()].some((job) => job.active);
  }

  async waitForIdle(): Promise<void> {
    while (this.hasRunning) {
      await Promise.all([...this.jobs.values()].map((job) => job.done));
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const running = [...this.jobs.values()].filter((job) => job.active);
    for (const job of running) job.controller.abort();
    await Promise.all(running.map((job) => job.done));
    const errors = running.flatMap((job) =>
      job.state.status === "failed" ? [new Error(job.state.error)] : [],
    );
    if (errors.length) throw new AggregateError(errors, "failed to stop Bash jobs");
  }
}

export function buildBashJobMetadata(args: {
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

function buildBashJobPresentation(
  toolName: string,
  args: { id?: string; ids?: string[] } | undefined,
  text?: string,
  metadata?: string[],
) {
  const detailText = text?.replace(/\r\n?/g, "\n").trimEnd();
  return buildToolRunPresentation({
    toolName,
    operation: toolName.includes("code") ? "code" : "bash",
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

export function createBashJobToolDefinitions(jobs: BashJobRegistry): AgentTool[] {
  return createJobToolDefinitions(jobs, "bash");
}

export function createJobToolDefinitions(
  jobs: BackgroundJobTools,
  kind: "bash" | "code",
): AgentTool[] {
  const id = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });
  const idSchema = z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/);
  const includeOutput = Type.Optional(
    Type.Boolean({
      description:
        "Include the latest captured output; defaults to true. Set false to return only job metadata. Error details are part of the output, so they are omitted too.",
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
      name: "list_bash_jobs",
      description:
        "List session-owned Bash jobs and their status, without output. Up to 64 records are retained; older completed jobs are evicted when needed.",
      parameters: Type.Object({}, { additionalProperties: false }),
      parser: z.object({}).strict(),
    },
    {
      name: "read_bash_job",
      description:
        "Read a Bash job's current status and the latest part of its captured output without waiting. When output is shortened, the result reports a text log with all retained text; read that file instead of rerunning the job.",
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
      name: "stop_bash_job",
      description:
        "Stop a Bash job and its process group, escalating to forced termination if needed. Waits until the job has stopped and returns its final record.",
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
      name: "wait_for_bash_jobs",
      description:
        "Wait until any requested Bash job finishes. To check whether a service is ready, inspect its output or probe it instead. Returns after 60 seconds by default, at most 5 minutes. Timeout and interruption cancel only the wait, not jobs. Completed results remain readable.",
      parameters: Type.Object(
        {
          includeOutput,
          maxOutputTokens,
          ids: Type.Array(id, { minItems: 1, maxItems: MAX_JOBS }),
          timeout: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: BASH_JOB_WAIT_MAX_MS,
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
          timeout: z.number().int().positive().max(BASH_JOB_WAIT_MAX_MS).optional(),
        })
        .strict(),
    },
  ]
    .map((definition) => ({
      ...definition,
      name: definition.name.replaceAll("bash", kind),
      description:
        kind === "code"
          ? definition.description
              .replaceAll("Bash", "code")
              .replace(
                "and its process group, escalating to forced termination if needed",
                "and its in-flight capability calls. Bash jobs the program started keep running",
              )
          : definition.description,
    }))
    .map(
      ({ parser, ...schema }): AgentTool => ({
        schema,
        describe: (call) => {
          const parsed = parser.safeParse(call.arguments);
          return {
            presentation: buildBashJobPresentation(
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
                  presentation: buildBashJobPresentation(schema.name, undefined, reason),
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
                  args.timeout ?? BASH_JOB_WAIT_DEFAULT_MS,
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
                const note = `Wait timed out after ${"timeout" in args ? (args.timeout ?? BASH_JOB_WAIT_DEFAULT_MS) : BASH_JOB_WAIT_DEFAULT_MS}ms; jobs are still running.\n\n`;
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
                  presentation: buildBashJobPresentation(
                    schema.name,
                    args,
                    text,
                    buildBashJobMetadata({
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
                  presentation: buildBashJobPresentation(
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
