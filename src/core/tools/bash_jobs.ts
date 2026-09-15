import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { z } from "zod";
import { truncateForTokens, truncateToBytesFromEnd } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import { formatBashToolResultText, getBashTerminationNotice } from "./bash.js";
import type { BashExecutionResult, ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation } from "./presentation.js";
import { type AgentTool, createTextToolOutcome, executeTool } from "./registry.js";

const MAX_JOBS = 64;
const MAX_OUTPUT_BYTES = 64 * 1024;
export const BASH_JOB_WAIT_DEFAULT_MS = 60_000;
export const BASH_JOB_WAIT_MAX_MS = 300_000;

interface BashJob {
  id: string;
  command: string;
  cwd: string;
  timeout: number | undefined;
  output: string;
  truncated: boolean;
  controller: AbortController;
  done: Promise<void>;
  state:
    | { status: "running" }
    | {
        status: "finished";
        result: Pick<BashExecutionResult, "exitCode" | "aborted" | "timedOut" | "closeSignal">;
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
    timeout: number | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Bash jobs are closed.");
    if (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => job.state.status !== "running");
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
      timeout,
      output: "",
      truncated: false,
      controller: new AbortController(),
      done: Promise.resolve(),
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
          timeoutMs: timeout,
          signal: job.controller.signal,
          maxCaptureBytes: MAX_OUTPUT_BYTES,
          onStarted: started,
          onOutput: (chunk) => {
            const output = job.output + decoder.write(chunk);
            job.truncated ||= Buffer.byteLength(output) > MAX_OUTPUT_BYTES;
            job.output = truncateToBytesFromEnd(output, MAX_OUTPUT_BYTES);
          },
        });
        job.output = truncateToBytesFromEnd(job.output + decoder.end(), MAX_OUTPUT_BYTES);
        job.truncated ||= result.truncated;
        const { exitCode, aborted, timedOut, closeSignal } = result;
        job.state = { status: "finished", result: { exitCode, aborted, timedOut, closeSignal } };
      } catch (error) {
        job.state = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    try {
      await Promise.race([launched, job.done]);
      signal.throwIfAborted();
      if (job.state.status === "failed") throw new Error(job.state.error);
      return `${this.formatJobs([job], false)}\nApplication readiness has not been checked.`;
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

  format(ids: string[] = [...this.jobs.keys()], includeOutput = true): string {
    return this.formatJobs(
      ids.map((id) => this.get(id)),
      includeOutput,
    );
  }

  private formatJobs(jobs: BashJob[], includeOutput: boolean): string {
    return (
      jobs
        .map((job) => {
          const id = job.id;
          const state = job.state;
          const status =
            state.status === "finished"
              ? state.result.timedOut
                ? "timed out"
                : state.result.aborted
                  ? "stopped"
                  : state.result.exitCode === 0
                    ? "succeeded"
                    : "failed"
              : state.status;
          const lines = [`\`${id}\` · ${job.command}`, status, `cwd ${job.cwd}`];
          if (state.status === "failed") lines.push(state.error);
          if (includeOutput) {
            const model = truncateForTokens(stripAnsi(job.output), {
              maxTokens: Math.min(2048, Math.floor(8192 / Math.max(1, jobs.length))),
              strategy: "tail",
            });
            lines.push(
              "",
              formatBashToolResultText({
                truncationInfo: { output: model.content, model, captureTruncated: job.truncated },
                exitCode: state.status === "finished" ? state.result.exitCode : null,
              }),
            );
          }
          if (state.status === "finished") {
            const notice = getBashTerminationNotice({
              ...state.result,
              timeoutMs: job.timeout ?? 0,
            });
            if (notice) lines.push(notice);
          }
          return lines.join("\n");
        })
        .join("\n\n") || "No Bash jobs."
    );
  }

  async stop(id: string): Promise<string> {
    const job = this.get(id);
    job.controller.abort();
    await job.done;
    if (job.state.status === "failed") throw new Error(job.state.error);
    return this.formatJobs([job], true);
  }

  async wait(ids: string[], timeout: number, signal: AbortSignal): Promise<string> {
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
      return `${this.formatJobs(jobs, true)}${timedOut ? `\n\nWait timed out after ${timeout}ms; jobs are still running.` : ""}`;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  get hasRunning(): boolean {
    return [...this.jobs.values()].some((job) => job.state.status === "running");
  }

  async waitForIdle(): Promise<void> {
    while (this.hasRunning) {
      await Promise.all([...this.jobs.values()].map((job) => job.done));
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const running = [...this.jobs.values()].filter((job) => job.state.status === "running");
    for (const job of running) job.controller.abort();
    await Promise.all(running.map((job) => job.done));
    const errors = running.flatMap((job) =>
      job.state.status === "failed" ? [new Error(job.state.error)] : [],
    );
    if (errors.length) throw new AggregateError(errors, "failed to stop Bash jobs");
  }
}

export function createBashJobToolDefinitions(jobs: BashJobRegistry): AgentTool[] {
  const id = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });
  const idSchema = z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/);
  return [
    {
      name: "list_bash_jobs",
      description:
        "List session-owned Bash jobs and their status. Up to 64 records are retained; older completed jobs are evicted when needed.",
      parameters: Type.Object({}, { additionalProperties: false }),
      parser: z.object({}).strict(),
    },
    {
      name: "read_bash_job",
      description:
        "Read a Bash job's status and bounded output tail immediately (up to 2048 tokens from 64 KiB retained output).",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      parser: z.object({ id: idSchema }).strict(),
    },
    {
      name: "stop_bash_job",
      description:
        "Stop a Bash job and its process group, escalating to forced termination if needed.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      parser: z.object({ id: idSchema }).strict(),
    },
    {
      name: "wait_for_bash_jobs",
      description:
        "Wait for any requested Bash job to exit, not for readiness. Use logs or readiness checks for servers. Returns after 60 seconds by default, at most 5 minutes. Timeout and interruption cancel only the wait, not jobs. Completed results remain readable.",
      parameters: Type.Object(
        {
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
          ids: z.array(idSchema).min(1).max(MAX_JOBS),
          timeout: z.number().int().positive().max(BASH_JOB_WAIT_MAX_MS).optional(),
        })
        .strict(),
    },
  ].map(
    ({ parser, ...schema }): AgentTool => ({
      schema,
      describe: () => ({
        presentation: buildToolRunPresentation({ toolName: schema.name, subject: "Bash jobs" }),
      }),
      execute: (call, context) =>
        executeTool(context, async () => {
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
                presentation: buildToolRunPresentation({
                  toolName: schema.name,
                  subject: "Bash jobs",
                  details: [{ text: reason }],
                }),
              },
            };
          }
          const args = parsed.data;
          const subject = "ids" in args ? String(args.ids) : "id" in args ? args.id : "Bash jobs";
          try {
            context.signal.throwIfAborted();
            const text =
              "ids" in args
                ? await jobs.wait(
                    args.ids,
                    args.timeout ?? BASH_JOB_WAIT_DEFAULT_MS,
                    context.signal,
                  )
                : "id" in args
                  ? schema.name === "stop_bash_job"
                    ? await jobs.stop(args.id)
                    : jobs.format([args.id])
                  : jobs.format(undefined, false);
            return {
              ...createTextToolOutcome(text, "succeeded"),
              uiEvent: {
                type: "tool_call_finished" as const,
                toolCallId: call.id,
                toolName: schema.name,
                status: "success" as const,
                presentation: buildToolRunPresentation({
                  toolName: schema.name,
                  subject: "Bash jobs",
                  details: text.split("\n").map((text) => ({ text })),
                }),
              },
            };
          } catch (error) {
            const reason = context.signal.aborted
              ? "Bash job operation was cancelled."
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
                presentation: buildToolRunPresentation({
                  toolName: schema.name,
                  subject,
                  details: context.signal.aborted ? [] : [{ text: reason }],
                }),
              },
            };
          }
        }),
    }),
  );
}
