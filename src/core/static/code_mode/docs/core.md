# Code Mode and @tau/core

Use `code` to pass data between calls, run independent work in parallel, or reduce a large result before returning it to the conversation. A standalone tool call is simpler when a program adds nothing.

## Running programs

Pass inline JavaScript in `code` or a saved `.js` program in `file`. Use static imports from an enabled `@tau/*` package or from a relative `.js` file. Relative paths resolve from the importing file, or from the current working directory for inline code. Top-level `await` works in both forms. Node, npm, and dynamic imports are unavailable. A program can load at most 64 source files, 1 MiB per saved file and 8 MiB in total.

Each call starts a fresh program. Return values are ignored. Use `printText` or `await printImage` to send results to the conversation. The tool's `maxOutputTokens` limits printed text, separately from API capture limits. A program may make at most 4,096 API requests, 32 concurrently. Each request or response must fit within 64 MiB on the bridge, so use service filters, pagination, or file paths for large payloads.

Foreground calls time out after five minutes by default. `timeout` on the tool call changes the deadline, up to an hour. Cancelling a program cancels its active requests, but does not undo completed side effects. A program launched with `background: true` has no overall deadline; inspect it with the code job tools. The background launch accepts neither `timeout` nor `maxOutputTokens`.

## Input, output, and docs

```js
import { input, printText, truncate } from "@tau/core";

printText(truncate(input.message, { maxChars: 2_000 }));
```

- `input` is the JSON value supplied to the tool, or `null` if omitted.
- `printText(text)` accepts a string. Print selected fields and the IDs needed for follow-up.
- `await printImage(bytes)` accepts a `Uint8Array` containing JPEG, PNG, or WebP data. Tau detects the format and prepares the image for the model. You can also pass a tool's `{ data, mimeType }` image block with base64 `data`. A program can print up to 16 images. Printed text and awaited images retain their order.
- `truncate(text, { maxChars, keep? })` or `truncate(text, { maxLines, keep? })` returns a string. Specify exactly one positive integer limit. `keep` is `"head"`, `"tail"`, or `"both"` (default). The `…` marker is outside the budget and takes its own line in line mode. Text that fits is unchanged.
- `await docs()` returns this page. Pass an enabled package name, such as `"@tau/web"`, for its reference, or `"examples"` for recipes. Reuse references already in context.

## Bash

Import `bash` from `@tau/core` when Bash is available. Each command runs in a fresh noninteractive Bash login shell. Pass input data through `stdin` instead of interpolating it into the command.

| Function | Result |
| --- | --- |
| `bash.text(command, options?)` | Untrimmed stdout on success. Nonzero exits, timeouts, and interrupted commands throw. Exit errors include `exitCode` and a short diagnostic. |
| `bash.run(command, options?)` | `{ exitCode, stdout, stderr, output, timedOut, aborted, closeSignal }`. Exit status and termination are data. `output` interleaves chunks as Tau receives them. For a single pipe use Bash redirection (`2>&1`). |
| `bash.start(command, { workingDirectory }?)` | `{ id }` for a background job. The job can outlive the program. |
| `bash.list()` / `bash.read(id)` | Job metadata for all retained jobs, or one job with its combined log tail. |
| `bash.wait(idOrIds, { timeout }?)` | Returns one finished job. An array waits for any listed job to finish. A timeout throws `WAIT_TIMEOUT` and leaves the jobs running. The wait defaults to 60 seconds and accepts up to five minutes. |
| `bash.stop(id)` | Stops the job's process group and returns its final state. |

For `run` and `text`, options are `workingDirectory`, `stdin` (UTF-8 text), and `timeout` in milliseconds (60 seconds by default). Above 24 MiB across stdout and stderr, Tau stops the process group and throws `OUTPUT_LIMIT`. Redirect large artifacts to a file. Background jobs instead keep up to 24 MiB of combined log tail and report truncation without stopping the command. Inspect job `status` (`running`, `succeeded`, `failed`, or `stopped`), and `exitCode` or `error` when present.

## Files

Import `files` from `@tau/core`. Reads require Bash permission; writes and edits require their respective tool permissions. Paths resolve as in the standalone tools. These are whole-file operations with a 16 MiB limit. Use Bash to process larger files in place.

| Function | Result |
| --- | --- |
| `files.readText(path)` | Complete UTF-8 string. Invalid UTF-8 throws. |
| `files.readBytes(path)` | Complete `Uint8Array`. |
| `files.writeText(path, text)` / `files.writeBytes(path, bytes)` | Create or replace a file and create missing parent directories. Returns `{ path, bytes }`. |
| `files.edit(path, oldText, newText)` / `files.edit(path, replacements)` | Apply exact replacements and return `{ path, replacements }`, with the number applied. A batch is an array of `{ oldText, newText }` objects. |

Each edit must match exactly once, including whitespace. A batch applies in order to the same file and writes only after every replacement matches. Separate calls commit independently. File and argument failures throw.
