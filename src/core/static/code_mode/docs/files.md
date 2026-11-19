# @tau/files

Read, write, and edit whole files. Paths resolve like the file tools, from the working directory or as absolute paths. The tool description names any function you are not permitted to call.

```js
import * as files from "@tau/files";

await files.edit("docs/quickstart.md", [
  { oldText: "npm run dev", newText: "npm start" },
  { oldText: "port 3000", newText: "port 4000" },
]);
```

## API

```ts
function readText(path: string): Promise<string>;
function readBytes(path: string): Promise<Uint8Array>;
function writeText(path: string, text: string): Promise<Written>;
function writeBytes(path: string, bytes: Uint8Array): Promise<Written>;
function edit(path: string, edits: Edit[]): Promise<{ path: string; edits: number }>;

type Written = { path: string; bytes: number }; // the resolved path
type Edit = { oldText: string; newText: string };
```

Writes create missing parent directories and replace existing files. `edit` applies up to 128 edits in order: each `oldText` must match exactly once, including whitespace, in the text left by the edits before it. The file is written only if every edit applies, and separate calls commit independently. Each operation handles one whole file of up to 16 MiB, so process larger files with Bash.

## Errors

| `code` | Meaning |
| --- | --- |
| `not_permitted` | The function is not permitted in this session. |
| `invalid_utf8` | `readText` or `edit` found bytes that are not UTF-8. |
| `file_too_large` | The file, or the text to write, exceeds 16 MiB. |
| `edit_no_match` | An `oldText` does not occur in the file. |
| `edit_ambiguous` | An `oldText` occurs more than once. |

Other failures, such as a missing file, throw with the system's message.
