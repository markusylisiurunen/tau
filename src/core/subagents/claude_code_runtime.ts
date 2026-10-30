import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import {
  type ClaudeCodeEvent,
  type ClaudeCodeResult,
  claudeCodeEventSchema,
  claudeCodeInputSchema,
} from "./claude_code_protocol.js";
import type { ClaudeCodeSubagentConfig } from "./types.js";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const EVENT_PREFIX = "tau-claude-code:";

// The bundle is shipped with Tau, not read from the agent's workspace. Sending it
// over stdin keeps the SDK available on remote environments without installing it
// there or putting a multi-megabyte script in the process argument list.
const RUNNER_BOOTSTRAP = `
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { source, input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const fs = require("node:fs");
  const directory = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "tau-claude-"));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  process.once("exit", cleanup);
  process.once("SIGTERM", () => process.exit(143));
  const emit = (event) => process.stdout.write(${JSON.stringify(EVENT_PREFIX)} + JSON.stringify(event) + "\\n");
  try {
    const path = require("node:path").join(directory, "runner.mjs");
    fs.writeFileSync(path, source, { mode: 0o600 });
    const { runClaudeCode } = await import(require("node:url").pathToFileURL(path).href);
    await runClaudeCode(input, emit, directory);
  } catch (error) {
    emit({ type: "error", message: String(error.message ?? error).slice(0, 8192) });
    process.exitCode = 1;
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
  }
})().catch(() => { process.stderr.write("failed to start Claude Code runner\\n"); process.exitCode = 1; });
`;

export class ClaudeCodeRuntime {
  private controller?: AbortController;
  private sessionId?: string;
  private disposed = false;
  private controlPath?: string;

  constructor(
    private readonly options: {
      config: ClaudeCodeSubagentConfig;
      backend: ToolExecutionBackend;
      onEvent: (event: ClaudeCodeEvent) => Promise<void>;
    },
  ) {}

  async steer(message: string): Promise<boolean> {
    if (!this.controlPath || !this.controller || this.controller.signal.aborted) return false;
    const result = await this.options.backend.runNodeScript(
      `
      (async () => {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const payload = Buffer.concat(chunks);
        const socket = require("node:net").connect(process.argv[1]);
        let output = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(payload));
        socket.on("data", chunk => output += chunk);
        socket.on("end", () => process.stdout.write(output));
        socket.on("error", error => { if (error.code === "ENOENT" || error.code === "ECONNREFUSED") process.stdout.write("closed"); else process.exitCode = 1; });
      })().catch(() => { process.exitCode = 1; });
    `,
      [this.controlPath],
      {
        timeoutMs: 10000,
        maxCaptureBytes: 1024,
        signal: this.controller.signal,
        stdin: Buffer.from(`${JSON.stringify({ message })}\n`),
      },
    );
    if (
      result.aborted ||
      result.exitCode !== 0 ||
      result.timedOut ||
      !["accepted", "closed"].includes(result.stdout.trim())
    )
      throw new Error(
        "Claude Code steering delivery could not be confirmed; the message was not retried.",
      );
    return result.stdout.trim() === "accepted";
  }

  interrupt(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.interrupt();
  }

  async submit(
    prompt: string,
  ): Promise<{ status: "interrupted" } | { status: "completed"; result: ClaudeCodeResult }> {
    if (this.disposed) throw new Error("Claude Code subagent is disposed");
    if (this.controller) throw new Error("Claude Code subagent is already running");
    const config = this.options.config;
    const input = claudeCodeInputSchema.parse({
      prompt,
      cwd: config.workingDirectory,
      model: config.model.id,
      effort: config.effort,
      tools: config.tools,
      sessionId: this.sessionId,
    });
    const source = readFileSync(new URL("./claude_code_runner.mjs", import.meta.url), "utf8");
    const controller = new AbortController();
    this.controller = controller;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    let events = Promise.resolve();
    let queuedEventBytes = 0;
    let failure: Error | undefined;
    let finalResult: ClaudeCodeResult | undefined;
    const accept = (line: string) => {
      if (!line.startsWith(EVENT_PREFIX)) return;
      const bytes = Buffer.byteLength(line);
      if (bytes + queuedEventBytes > 32 * 1024 * 1024)
        throw new Error("Claude Code event backlog exceeds the limit");
      const event = claudeCodeEventSchema.parse(JSON.parse(line.slice(EVENT_PREFIX.length)));
      if (event.type === "control") this.controlPath = event.path;
      if (event.type === "session") this.sessionId = event.id;
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "result") finalResult = event;
      queuedEventBytes += bytes;
      events = events
        .then(async () => {
          try {
            if (!failure) await this.options.onEvent(event);
          } finally {
            queuedEventBytes -= bytes;
          }
        })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        });
    };
    const onOutput = (chunk: Buffer) => {
      if (failure) return;
      try {
        buffer += decoder.write(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_EVENT_BYTES)
            throw new Error("Claude Code event exceeds the output limit");
          accept(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES)
          throw new Error("Claude Code event exceeds the output limit");
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      }
    };
    let completed = false;
    try {
      const result = await this.options.backend.runNodeScript(RUNNER_BOOTSTRAP, [], {
        cwd: config.workingDirectory,
        stdin: Buffer.from(JSON.stringify({ source, input })),
        signal: controller.signal,
        maxCaptureBytes: 8192,
        onOutput,
      });
      await events;
      if (failure) throw failure;
      if (result.aborted || controller.signal.aborted) {
        return { status: "interrupted" };
      }
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(
          `Claude Code process failed (exit ${result.exitCode ?? result.closeSignal ?? "unknown"}). ${result.stderr.slice(-2048)}`,
        );
      }
      if (buffer.trim() || decoder.end())
        throw new Error("Claude Code stream ended with an incomplete event");
      if (!finalResult) throw new Error("Claude Code completed without a result");
      completed = true;
      return { status: "completed", result: finalResult };
    } finally {
      if (!completed) controller.abort();
      await events;
      this.controller = undefined;
      this.controlPath = undefined;
    }
  }
}
