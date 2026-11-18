import { resolve } from "node:path";
import { z } from "zod";
import { SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES } from "../../protocol/session_protocol.js";
import { JOB_WAIT_DEFAULT_MS, JOB_WAIT_MAX_MS } from "../tools/background_jobs.js";
import { BASH_DEFAULT_TIMEOUT_MS } from "../tools/bash.js";
import type { BashJobRegistry } from "../tools/bash_jobs.js";
import {
  MAX_COMMAND_CAPTURE_BYTES,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import type { CodeModeCapability } from "./capability.js";
import { codeModeError } from "./errors.js";

const commandOptions = {
  workingDirectory: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .optional(),
};
const runOptions = z.strictObject({
  ...commandOptions,
  stdin: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES,
      "stdin exceeds its UTF-8 byte limit",
    )
    .optional(),
  timeout: z.number().positive().optional(),
});
const startOptions = z.strictObject(commandOptions);
const command = z.string().refine((value) => value.trim().length > 0);
const id = z.string().min(1);
const waitOptions = z.strictObject({
  timeout: z.number().int().positive().max(JOB_WAIT_MAX_MS).optional(),
});

export function createBashCapability(
  backend: ToolExecutionBackend,
  cwd: string,
  jobs: BashJobRegistry,
): CodeModeCapability {
  const run = async (args: unknown[], signal: AbortSignal) => {
    const [source, options] = z.tuple([command, runOptions.optional()]).parse(args);
    const { truncated, ...result } = await backend.runBash(source, {
      cwd: resolve(cwd, options?.workingDirectory ?? "."),
      timeoutMs: options?.timeout ?? BASH_DEFAULT_TIMEOUT_MS,
      maxCaptureBytes: MAX_COMMAND_CAPTURE_BYTES,
      terminateOnCaptureLimit: true,
      stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin, "utf8"),
      signal,
    });
    if (truncated) throw codeModeError("OUTPUT_LIMIT", "Command output exceeded 24 MiB");
    return result;
  };
  return {
    name: "bash",
    description: "Run Bash commands and manage background jobs.",
    api: {
      run: (args, context) => run(args, context.signal),
      text: async (args, context) => {
        const result = await run(args, context.signal);
        if (!result.timedOut && !result.aborted && result.exitCode === 0) return result.stdout;
        const code = result.timedOut
          ? "COMMAND_TIMEOUT"
          : result.aborted
            ? "COMMAND_ABORTED"
            : "COMMAND_FAILED";
        const outcome = result.timedOut
          ? "timed out"
          : result.aborted
            ? "was interrupted"
            : result.closeSignal
              ? `was terminated by ${result.closeSignal}`
              : `exited with code ${result.exitCode}`;
        const detail = (result.stderr || result.output).trim().slice(-1500);
        throw Object.assign(
          codeModeError(code, `Command ${outcome}${detail ? `: ${detail}` : ""}`),
          {
            exitCode: result.exitCode,
          },
        );
      },
      start: async (args, context) => {
        const [source, options] = z.tuple([command, startOptions.optional()]).parse(args);
        return {
          id: await jobs.start(
            backend,
            source,
            resolve(cwd, options?.workingDirectory ?? "."),
            context.signal,
          ),
        };
      },
      list: (args) => {
        z.tuple([]).parse(args);
        return jobs.read(undefined, false);
      },
      read: (args) => {
        const [jobId] = z.tuple([id]).parse(args);
        return jobs.read([jobId])[0]!;
      },
      wait: async (args, context) => {
        const [selection, options] = z
          .tuple([z.union([id, z.array(id).min(1).max(64)]), waitOptions.optional()])
          .parse(args);
        const ids = Array.isArray(selection) ? selection : [selection];
        return jobs.waitForFinished(ids, options?.timeout ?? JOB_WAIT_DEFAULT_MS, context.signal);
      },
      stop: async (args) => {
        const [jobId] = z.tuple([id]).parse(args);
        await jobs.stopJob(jobId);
        return jobs.read([jobId])[0]!;
      },
    },
  };
}
