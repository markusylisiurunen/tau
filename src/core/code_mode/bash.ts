import { resolve } from "node:path";
import { z } from "zod";
import { codeModeError } from "../../code_mode/errors.js";
import { SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES } from "../../protocol/session_protocol.js";
import { JOB_WAIT_DEFAULT_MS, JOB_WAIT_MAX_MS } from "../tools/background_jobs.js";
import { BASH_DEFAULT_TIMEOUT_MS } from "../tools/bash.js";
import type { BashJobRegistry } from "../tools/bash_jobs.js";
import {
  MAX_COMMAND_CAPTURE_BYTES,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import { type CodeModePackage, definePackage, method } from "./package.js";

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

export function createBashPackage(
  backend: ToolExecutionBackend,
  cwd: string,
  jobs: BashJobRegistry,
): CodeModePackage {
  const run = async (
    source: string,
    options: z.output<typeof runOptions> | undefined,
    signal: AbortSignal,
  ) => {
    const { truncated, ...result } = await backend.runBash(source, {
      cwd: resolve(cwd, options?.workingDirectory ?? "."),
      timeoutMs: options?.timeout ?? BASH_DEFAULT_TIMEOUT_MS,
      maxCaptureBytes: MAX_COMMAND_CAPTURE_BYTES,
      terminateOnCaptureLimit: true,
      stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin, "utf8"),
      signal,
    });
    if (truncated) throw codeModeError("output_limit", "Command output exceeded 24 MiB");
    return result;
  };
  return definePackage("bash", "Run Bash commands and manage background jobs.", {
    run: method(z.tuple([command, runOptions.optional()]), ([source, options], { signal }) =>
      run(source, options, signal),
    ),
    text: method(
      z.tuple([command, runOptions.optional()]),
      async ([source, options], { signal }) => {
        const result = await run(source, options, signal);
        if (!result.timedOut && !result.aborted && result.exitCode === 0) return result.stdout;
        const code = result.timedOut
          ? "command_timeout"
          : result.aborted
            ? "command_interrupted"
            : "command_failed";
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
          { exitCode: result.exitCode },
        );
      },
    ),
    start: method(
      z.tuple([command, startOptions.optional()]),
      async ([source, options], { signal }) => ({
        id: await jobs.start(
          backend,
          source,
          resolve(cwd, options?.workingDirectory ?? "."),
          signal,
        ),
      }),
    ),
    list: method(z.tuple([]), () => jobs.read(undefined, false)),
    read: method(z.tuple([id]), ([jobId]) => jobs.read([jobId])[0]!),
    wait: method(
      z.tuple([z.union([id, z.array(id).min(1).max(64)]), waitOptions.optional()]),
      ([selection, options], { signal }) =>
        jobs.waitForFinished(
          Array.isArray(selection) ? selection : [selection],
          options?.timeout ?? JOB_WAIT_DEFAULT_MS,
          signal,
        ),
    ),
    stop: method(z.tuple([id]), async ([jobId]) => {
      await jobs.stopJob(jobId);
      return jobs.read([jobId])[0]!;
    }),
  });
}
