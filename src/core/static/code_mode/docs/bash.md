# @tau/bash

Run Bash commands and background jobs. Each command runs in a fresh noninteractive Bash login shell, so `cd` and variables do not carry over. Pass data through `stdin` instead of interpolating it into the command.

```js
import * as bash from "@tau/bash";
import { printText, truncate } from "@tau/core";

const result = await bash.run("npm test 2>&1", { timeout: 300_000 });
printText(result.exitCode === 0
  ? "tests passed"
  : truncate(result.stdout, { maxLines: 80, keep: "tail" }));
```

## API

```ts
function text(command: string, options?: RunOptions): Promise<string>;
function run(command: string, options?: RunOptions): Promise<CommandResult>;
function start(command: string, options?: { workingDirectory?: string }): Promise<{ id: string }>;
function list(): Promise<Job[]>;
function read(id: string): Promise<JobWithLog>;
function wait(ids: string | string[], options?: { timeout?: number }): Promise<JobWithLog>;
function stop(id: string): Promise<JobWithLog>;

type RunOptions = {
  workingDirectory?: string; // relative to the working directory
  stdin?: string; // UTF-8, up to 16 MiB
  timeout?: number; // milliseconds, default 60000
};

type CommandResult = {
  exitCode: number | null; // null when a signal ended the command
  stdout: string;
  stderr: string;
  output: string; // stdout and stderr interleaved in arrival order
  timedOut: boolean;
  aborted: boolean; // interrupted
  closeSignal: string | null;
};

type Job = {
  id: string;
  command: string;
  workingDirectory: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  truncated: boolean; // the log dropped its earliest output
  exitCode?: number | null; // once finished
  aborted?: boolean;
  closeSignal?: string | null;
};
type JobWithLog = Job & {
  output: string; // combined log, the last 24 MiB
  error?: string; // why the job could not start
};
```

## Commands

`text` returns untrimmed stdout and throws unless the command exits with 0. `run` returns failures as data. Use `2>&1` to read both streams through stdout. If stdout and stderr together exceed 24 MiB, the command is stopped and the call fails, so redirect large output to a file.

## Jobs

`start` returns at once, and the job keeps running after the program ends. These are the same jobs the Bash job tools manage. `wait` returns the first listed job that has finished, waiting 60 seconds by default and at most 300000 ms, for up to 64 IDs. A timeout leaves the jobs running. `stop` stops the job and its child processes and returns its final state.

## Errors

| `code` | Meaning |
| --- | --- |
| `command_failed` | `text` saw a nonzero exit or a signal. The error has `exitCode`, and its message ends with the command's last output. |
| `command_timeout` | The command passed its `timeout`. |
| `command_interrupted` | The command was interrupted. |
| `output_limit` | The command printed more than 24 MiB and was stopped. |
| `wait_timeout` | No listed job finished in time. |
