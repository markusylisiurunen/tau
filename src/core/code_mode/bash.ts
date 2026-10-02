import { resolve } from "node:path";
import { z } from "zod";
import { BASH_DEFAULT_TIMEOUT_MS } from "../tools/bash.js";
import {
  BASH_JOB_WAIT_DEFAULT_MS,
  BASH_JOB_WAIT_MAX_MS,
  type BashJobRegistry,
} from "../tools/bash_jobs.js";
import {
  MAX_COMMAND_CAPTURE_BYTES,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import type { CodeModeCapability } from "./capability.js";

const commandOptions = {
  command: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0),
  workingDirectory: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .optional(),
};
const runOptions = z.strictObject({
  ...commandOptions,
  timeout: z.number().int().positive().optional(),
});
const startOptions = z.strictObject(commandOptions);
const idOptions = z.strictObject({ id: z.string().min(1) });
const waitOptions = z.strictObject({
  ids: z.array(z.string().min(1)).min(1).max(64),
  timeout: z.number().int().positive().max(BASH_JOB_WAIT_MAX_MS).optional(),
});

export function createBashCapability(
  backend: ToolExecutionBackend,
  cwd: string,
  jobs: BashJobRegistry,
): CodeModeCapability {
  return {
    name: "bash",
    description:
      "Run fresh noninteractive login Bash commands. Use run for foreground work and start for persistent background jobs. Never use tmux or shell &. Launch is not readiness.",
    documentation: `## tau.bash

- await tau.bash.run({ command, workingDirectory?, timeout? }) returns { output, stdout, stderr, exitCode, truncated, timedOut, aborted, closeSignal }. Timeout is in milliseconds, default ${BASH_DEFAULT_TIMEOUT_MS}. Nonzero exits are data; invalid arguments or launch failures throw.
- Foreground output is captured up to ${MAX_COMMAND_CAPTURE_BYTES} bytes, with a tail retained on overflow. Check truncated before parsing: incomplete output is not a complete JSON document. Use redirection to a file for larger artifacts. Programs decide what to print.
- await tau.bash.start({ command, workingDirectory? }) returns { id }. This does not check application readiness. Jobs survive program exit, turn interruption, and client disconnect while Tau remains running; they are not recovered after restart.
- await tau.bash.list() returns job metadata without output.
- await tau.bash.read({ id }) returns metadata and a bounded output tail.
- await tau.bash.wait({ ids, timeout? }) returns { jobs, timedOut } when any job exits or the wait expires. Default ${BASH_JOB_WAIT_DEFAULT_MS} ms, maximum ${BASH_JOB_WAIT_MAX_MS} ms. Cancelling or expiring a wait does not stop jobs.
- await tau.bash.stop({ id }) terminates the process group, escalating to forced termination, and returns the job record.

Job records contain id, command, workingDirectory, status, output, truncated, and exit/termination or error fields when available. Each job retains 64 KiB of output; up to 64 records are retained. Unknown IDs do not prove a command never ran: check current process and output state before restarting it.

Each command uses a fresh shell. No TTY or interactive stdin is available. workingDirectory defaults to the current working directory; prefer it over cd. Shell state does not carry between calls, but filesystem side effects do. Interrupting a program stops foreground commands, not already launched background jobs. Commands are not automatically retried and completed actions are not rolled back.`,
    api: {
      run: async (args, context) => {
        const [options] = z.tuple([runOptions]).parse(args);
        return await backend.runBash(options.command, {
          cwd: resolve(cwd, options.workingDirectory ?? "."),
          timeoutMs: options.timeout ?? BASH_DEFAULT_TIMEOUT_MS,
          maxCaptureBytes: MAX_COMMAND_CAPTURE_BYTES,
          signal: context.signal,
        });
      },
      start: async (args, context) => {
        const [options] = z.tuple([startOptions]).parse(args);
        return {
          id: await jobs.start(
            backend,
            options.command,
            resolve(cwd, options.workingDirectory ?? "."),
            context.signal,
          ),
        };
      },
      list: (args) => {
        z.tuple([]).parse(args);
        return jobs.read(undefined, false);
      },
      read: (args) => {
        const [options] = z.tuple([idOptions]).parse(args);
        return jobs.read([options.id])[0];
      },
      wait: async (args, context) => {
        const [options] = z.tuple([waitOptions]).parse(args);
        const timedOut = await jobs.waitJobs(
          options.ids,
          options.timeout ?? BASH_JOB_WAIT_DEFAULT_MS,
          context.signal,
        );
        return { jobs: jobs.read(options.ids), timedOut };
      },
      stop: async (args) => {
        const [options] = z.tuple([idOptions]).parse(args);
        await jobs.stopJob(options.id);
        return jobs.read([options.id])[0];
      },
    },
  };
}
