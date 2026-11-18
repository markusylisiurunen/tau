# Code Mode and @tau/core

## Running programs

Pass inline JavaScript in `code` or the path of a saved `.js` program in `file`. Programs use static imports from enabled `@tau/*` packages and from relative `.js` files. A relative path resolves from the importing file, or from the working directory for inline code. Top-level `await` works. Node built-ins, npm packages, and dynamic imports are unavailable. A program can load at most 64 source files, each saved file up to 1 MiB and 8 MiB in total.

Each call starts a fresh program, so values from earlier calls are gone. Return values are ignored, and only what you print comes back. `maxOutputTokens` on the tool call limits printed text. A program can make at most 4,096 API calls, 32 at a time. The arguments and result of each call must fit within 64 MiB, so request less with filters, pagination, or file paths when a result could be large.

Foreground calls time out after five minutes unless the tool call sets `timeout` in milliseconds, up to an hour. Cancelling or timing out a program cancels its active calls, but completed side effects stay. A program launched with `background: true` has no overall deadline and accepts neither `timeout` nor `maxOutputTokens`. Inspect it with the code job tools.

## Input, output, and docs

```js
import { input, printText, truncate } from "@tau/core";

printText(truncate(input.message, { maxChars: 2_000 }));
```

- `input` is the JSON value passed to the tool, or `null` if none was passed.
- `printText(text)` accepts only a string. Print the fields you need and the IDs you will use in follow-up calls.
- `await printImage(image)` accepts a `Uint8Array` of JPEG, PNG, or WebP data, or an image block `{ data, mimeType }` with base64 `data`, as MCP tools return. A program can print up to 16 images. Printed text and images keep their order.
- `truncate(text, { maxChars, keep? })` or `truncate(text, { maxLines, keep? })` shortens a string to one positive integer limit. `keep` is `"head"`, `"tail"`, or `"both"` (the default). The `…` marker does not count toward the limit, and in line mode it takes its own line. Text that fits is returned unchanged.
- `await docs()` returns this page. `docs("@tau/web")` returns the reference for an enabled package, and `docs("examples")` returns recipes.

## Bash

`bash` is available when Bash is enabled. Each command runs in a fresh noninteractive Bash login shell. Pass data through `stdin` instead of interpolating it into the command.

| Function | Result |
| --- | --- |
| `bash.text(command, options?)` | Untrimmed stdout. A nonzero exit, timeout, or interruption throws, and exit errors include `exitCode` and a short diagnostic. |
| `bash.run(command, options?)` | `{ exitCode, stdout, stderr, output, timedOut, aborted, closeSignal }`, so failures are data. `output` interleaves stdout and stderr in the order Tau received them. Use `2>&1` to send both streams through one pipe. |
| `bash.start(command, { workingDirectory }?)` | `{ id }` of a background job, which can outlive the program. |
| `bash.list()` / `bash.read(id)` | Metadata for all retained jobs, or one job with the tail of its combined log. |
| `bash.wait(idOrIds, { timeout }?)` | Waits for any listed job to finish and returns one finished job. Waits 60 seconds by default and at most five minutes. A timeout throws `WAIT_TIMEOUT` and leaves the jobs running. |
| `bash.stop(id)` | Stops the job's process group and returns its final state. |

`run` and `text` accept `workingDirectory`, `stdin` (UTF-8 text), and `timeout` in milliseconds (60 seconds by default). If stdout and stderr together exceed 24 MiB, Tau stops the command and throws `OUTPUT_LIMIT`, so redirect large output to a file. Background jobs keep running and retain the last 24 MiB of their combined log. Check `truncated` to see whether earlier output was dropped. A job's `status` is `running`, `succeeded`, `failed`, or `stopped`, with `exitCode` or `error` when present.

## Files

`files` holds the operations your tools permit: reads with Bash, writes with `write`, and `edit` with `edit`. Paths resolve as in the standalone tools. Each operation handles a whole file of up to 16 MiB. Process larger files with Bash.

| Function | Result |
| --- | --- |
| `files.readText(path)` | The file as a string. Invalid UTF-8 throws. |
| `files.readBytes(path)` | The file as a `Uint8Array`. |
| `files.writeText(path, text)` / `files.writeBytes(path, bytes)` | Creates or replaces the file, with any missing parent directories. Returns `{ path, bytes }`. |
| `files.edit(path, oldText, newText)` / `files.edit(path, replacements)` | Applies exact replacements, given as an array of `{ oldText, newText }` for a batch. Returns `{ path, replacements }` with the number applied. |

Failures throw, such as a missing file or an `oldText` that does not match exactly once, including whitespace. A batch applies in order and writes the file only if every replacement matches. Separate calls commit independently.
