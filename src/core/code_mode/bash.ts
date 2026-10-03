import { resolve } from "node:path";
import { z } from "zod";
import { SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES } from "../../protocol/session_protocol.js";
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
  stdin: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES,
      "stdin exceeds its UTF-8 byte limit",
    )
    .optional(),
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
      "Run shell commands and manage background jobs. Prefer the direct bash tool for straightforward shell work; use tau.bash when composing with other capabilities or processing command results in JavaScript.",
    documentation: `# tau.bash

Run foreground shell commands and manage persistent background jobs.

## Interface

\`\`\`ts
type BashApi = {
  run(options: RunOptions): Promise<RunResult>;
  start(options: StartOptions): Promise<StartResult>;
  list(): Promise<ListResult>;
  read(options: ReadOptions): Promise<ReadResult>;
  wait(options: WaitOptions): Promise<WaitResult>;
  stop(options: StopOptions): Promise<StopResult>;
};
\`\`\`

## Shell behavior

Each command runs in a fresh noninteractive login Bash shell. No TTY or interactive stdin is available. \`workingDirectory\` defaults to the current working directory; relative paths resolve from it. Prefer it over cd. Shell state does not carry between calls, but filesystem side effects do.

Use \`run\` for foreground work and \`start\` for persistent background jobs. Never use tmux or shell &.

## \`tau.bash.run(options)\`

Run a foreground command and await its completion.

### Options

\`\`\`ts
type RunOptions = {
  command: string;
  stdin?: string;
  workingDirectory?: string;
  timeout?: number;
};
\`\`\`

- \`command\`: required, nonblank Bash source.
- \`stdin\`: optional UTF-8 text, at most ${SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES / 1024 / 1024} MiB. Written once, then closed so the command receives EOF. Omit for no stdin; an empty string supplies an empty stream. No interactive input or TTY is available. Pass data through stdin rather than interpolating it into command source.
- \`workingDirectory\`: optional, nonempty path without line breaks.
- \`timeout\`: optional positive integer in milliseconds, default ${BASH_DEFAULT_TIMEOUT_MS}. The enclosing program's time limit still applies.

### Result

\`\`\`ts
type RunResult = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: string | null;
};
\`\`\`

\`output\` combines stdout and stderr; \`stdout\` and \`stderr\` are also returned separately. \`exitCode\` is null when no exit code is available. \`closeSignal\` names the terminating signal when available.

Nonzero exits, timeouts, and capture truncation are result data, not thrown errors. Check \`exitCode\`, \`truncated\`, \`timedOut\`, and \`aborted\` before using output as complete evidence or parsing it as JSON.

Foreground capture is bounded to ${MAX_COMMAND_CAPTURE_BYTES / 1024 / 1024} MiB, retaining a tail on overflow. Redirect larger artifacts to a file. Programs decide what to print; captured output is not automatically returned to the conversation.

For example, with jq installed on PATH:

\`\`\`js
const data = { items: ["one", "two"] };
const result = await tau.bash.run({
  command: "jq '.items | length'",
  stdin: JSON.stringify(data),
});
if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted)
  throw new Error("incomplete command result");
printText(result.stdout);
\`\`\`

Interrupting the program stops its foreground commands.

## \`tau.bash.start(options)\`

Launch a background command without waiting for it to finish.

### Options

\`\`\`ts
type StartOptions = {
  command: string;
  workingDirectory?: string;
};
\`\`\`

\`command\` and \`workingDirectory\` follow the same rules as \`run\`. Neither \`stdin\` nor a command timeout is accepted; stop the job explicitly when needed.

### Result

\`\`\`ts
type StartResult = { id: string };
\`\`\`

The returned ID identifies the job, not application readiness. Inspect output or perform a task-specific readiness check before depending on a launched service.

Jobs survive program completion, turn interruption, and client disconnect while Tau remains running. Already launched jobs are not stopped when a program is interrupted. Jobs are not recovered after restart.

## Job types

\`\`\`ts
type JobMetadata = {
  id: string;
  command: string;
  workingDirectory: string;
  truncated: boolean;
} & (
  | { status: "running" }
  | {
      status: "succeeded" | "failed" | "stopped";
      exitCode: number | null;
      aborted: boolean;
      closeSignal: string | null;
    }
  | { status: "failed"; error: string }
);

type Job = JobMetadata & { output: string };
\`\`\`

An exited command has \`exitCode\`, \`aborted\`, and \`closeSignal\`. An execution error instead has \`error\`. A \`failed\` status can represent either a nonzero command exit or an execution error; inspect the corresponding fields. A \`stopped\` status indicates the job was aborted.

\`command\` and \`workingDirectory\` are bounded display strings and may be truncated. Each job retains the last 64 KiB of combined output. \`truncated\` indicates that capture is incomplete.

Up to 64 job records are retained. Starting another job may evict an older completed record; if all records are running, launch fails. Unknown IDs throw and do not prove a command never ran. Check current process and output state before restarting it.

## \`tau.bash.list()\`

List retained jobs without their output.

\`\`\`ts
type ListResult = JobMetadata[];
\`\`\`

Takes no arguments. Use \`read\` for a selected job's output.

## \`tau.bash.read(options)\`

Read one job's current state and bounded output tail without waiting for completion.

\`\`\`ts
type ReadOptions = { id: string };
type ReadResult = Job;
\`\`\`

\`id\` is required. Running jobs may have more output later.

## \`tau.bash.wait(options)\`

Wait until any selected job finishes or the wait expires. Returns immediately if a selected job is already terminal. Other selected jobs may still be running.

### Options

\`\`\`ts
type WaitOptions = {
  ids: string[];
  timeout?: number;
};
\`\`\`

- \`ids\`: required, 1 to 64 nonempty job IDs.
- \`timeout\`: optional positive integer in milliseconds, default ${BASH_JOB_WAIT_DEFAULT_MS}, maximum ${BASH_JOB_WAIT_MAX_MS}.

### Result

\`\`\`ts
type WaitResult = {
  jobs: Job[];
  timedOut: boolean;
};
\`\`\`

\`jobs\` contains the current records for the requested IDs, including output. \`timedOut\` describes the wait, not a command outcome. Expiring or cancelling a wait does not stop the jobs.

## \`tau.bash.stop(options)\`

Stop one job's process group, escalating to forced termination when needed, and await completion.

\`\`\`ts
type StopOptions = { id: string };
type StopResult = Job;
\`\`\`

\`id\` is required. Returns the completed job record with its output tail. Stopping an already completed job returns its existing record. Execution errors throw.

## Limits and failures

Invalid arguments, unknown job IDs, and launch failures throw. Errors after a background launch appear in the job record; inspect \`status\` and its exit or error fields. Commands are not automatically retried, and completed filesystem or process actions are not rolled back.`,
    api: {
      run: async (args, context) => {
        const [options] = z.tuple([runOptions]).parse(args);
        return await backend.runBash(options.command, {
          cwd: resolve(cwd, options.workingDirectory ?? "."),
          timeoutMs: options.timeout ?? BASH_DEFAULT_TIMEOUT_MS,
          maxCaptureBytes: MAX_COMMAND_CAPTURE_BYTES,
          stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin, "utf8"),
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
