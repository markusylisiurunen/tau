import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { truncateForTokens } from "../utils/truncate.js";
import { MAX_JOBS, waitForJobs } from "./background_jobs.js";
import {
  type BashExecutionResult,
  MAX_COMMAND_CAPTURE_BYTES,
  type ToolExecutionBackend,
} from "./execution_backend.js";
import { JobOutput } from "./job_output.js";

interface BashJob {
  id: string;
  command: string;
  cwd: string;
  log: JobOutput;
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
      log: new JobOutput(backend, MAX_COMMAND_CAPTURE_BYTES),
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
          maxCaptureBytes: MAX_COMMAND_CAPTURE_BYTES,
          onStarted: started,
          onOutput: (chunk) => {
            const text = decoder.write(chunk);
            job.log.capture.appendText(text);
          },
        });
        const tail = decoder.end();
        job.log.capture.appendText(tail);
        job.log.capture.truncated ||= result.truncated;
        const { exitCode, aborted, closeSignal } = result;
        job.state = { status: "finished", result: { exitCode, aborted, closeSignal } };
      } catch (error) {
        job.log.capture.appendText(`\n${error instanceof Error ? error.message : String(error)}`);
        job.state = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await job.log.finish();
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
        ...(includeOutput ? { output: job.log.capture.text } : {}),
        truncated: job.log.capture.truncated,
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
    ids = [...new Set(ids)];
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
            const output = job.log.format(Math.floor(maxOutputTokens / Math.max(1, ids.length)));
            truncated ||= output.truncated;
            lines.push(...output.metadata, "", "--- output ---", output.projection.content);
          }
          return lines.join("\n");
        })
        .join("\n\n") || "No Bash jobs.";
    return { text, truncated };
  }

  async inspect(ids?: string[], includeOutput = true, maxOutputTokens = 8192) {
    return this.format(ids, includeOutput, maxOutputTokens);
  }

  async stopJob(id: string): Promise<void> {
    const job = this.get(id);
    job.controller.abort();
    await job.done;
    if (job.state.status === "failed") throw new Error(job.state.error);
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
