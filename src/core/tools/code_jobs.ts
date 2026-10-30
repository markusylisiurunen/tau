import { randomUUID } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  type ExecuteTauCodeModeOptions,
  runTauCodeMode,
  type TauCodeModeJsonValue,
} from "../../code_mode/runtime.js";
import { SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES } from "../../protocol/session_protocol.js";
import { truncateForTokens } from "../utils/truncate.js";
import { MAX_JOBS, waitForJobs } from "./background_jobs.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { JobOutput } from "./job_output.js";

type CodeJob = {
  id: string;
  source: string;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  controller: AbortController;
  output: JobOutput;
  done: Promise<void>;
  active: boolean;
};

export class CodeJobRegistry {
  private readonly jobs = new Map<string, CodeJob>();
  private closed = false;

  start(options: {
    source: string;
    cwd: string;
    backend: ToolExecutionBackend;
    program: Pick<ExecuteTauCodeModeOptions, "name" | "documentation" | "api" | "code"> & {
      input?: TauCodeModeJsonValue;
    };
    signal: AbortSignal;
  }): string {
    options.signal.throwIfAborted();
    if (this.closed) throw new Error("Code jobs are closed.");
    if (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => !job.active);
      if (!oldest)
        throw new Error(
          `Code job limit reached (${MAX_JOBS}). Stop a job before starting another.`,
        );
      this.jobs.delete(oldest.id);
    }
    const job: CodeJob = {
      id: randomUUID(),
      source: truncateForTokens(options.source, { maxTokens: 128, strategy: "middle" }).content,
      cwd: truncateForTokens(options.cwd, { maxTokens: 128, strategy: "middle" }).content,
      status: "running",
      controller: new AbortController(),
      output: new JobOutput(options.backend),
      done: Promise.resolve(),
      active: true,
    };
    this.jobs.set(job.id, job);
    job.done = (async () => {
      try {
        const result = await runTauCodeMode({
          ...options.program,
          timeoutMs: null,
          signal: job.controller.signal,
          output: job.output.capture,
        });
        job.output.capture.truncated ||= result.execution.truncated;
        job.status =
          result.status === "cancelled"
            ? "stopped"
            : result.status === "succeeded"
              ? "succeeded"
              : "failed";
      } catch (error) {
        job.output.capture.appendText(
          `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
        );
        job.status = job.controller.signal.aborted ? "stopped" : "failed";
      }
      await job.output.save();
      job.active = false;
    })();
    return job.id;
  }

  private get(id: string): CodeJob {
    const job = this.jobs.get(id);
    if (!job)
      throw new Error(
        `Unknown code job '${id}' (jobs are not recovered after restart and older completed records may be evicted).`,
      );
    return job;
  }

  async inspect(ids = [...this.jobs.keys()], includeOutput = true, maxOutputTokens = 8192) {
    const content: Array<TextContent | ImageContent> = [];
    let truncated = false;
    let images = 0;
    const jobs = [...new Set(ids)].map((id) => this.get(id));
    for (const job of jobs) {
      const output = includeOutput
        ? await job.output.project(Math.floor(maxOutputTokens / jobs.length))
        : undefined;
      const header = [
        `id: ${job.id}`,
        `status: ${job.status}`,
        `source: ${JSON.stringify(job.source)}`,
        `cwd: ${JSON.stringify(job.cwd)}`,
        ...(output ? [...output.metadata, "", "--- output ---"] : []),
      ].join("\n");
      if (content.length) content.push({ type: "text", text: "\n\n" });
      content.push({ type: "text", text: header });
      if (output) {
        truncated ||= output.truncated;
        for (const part of output.content) {
          if (part.type === "image" && ++images > SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES) continue;
          content.push(part);
        }
      }
    }
    if (images > SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES) {
      truncated = true;
      content.push({
        type: "text",
        text: `Images omitted: ${images - SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES}. Read jobs individually to retrieve their images.`,
      });
    }
    if (!content.length) content.push({ type: "text", text: "No code jobs." });
    const text = content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return { text, content, truncated };
  }

  async stopJob(id: string): Promise<void> {
    const job = this.get(id);
    job.controller.abort();
    await job.done;
  }

  async waitJobs(ids: string[], timeout: number, signal: AbortSignal): Promise<boolean> {
    return waitForJobs(
      [...new Set(ids)].map((id) => this.get(id)),
      timeout,
      signal,
    );
  }

  get hasRunning(): boolean {
    return [...this.jobs.values()].some((job) => job.active);
  }

  async waitForIdle(): Promise<void> {
    while (this.hasRunning) await Promise.all([...this.jobs.values()].map((job) => job.done));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }
}
