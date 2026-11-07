# TUI

`tau` starts the terminal interface in the current directory, and `tau attach` starts the same interface against a [remote host](remote-sessions.md). `/help` lists every command, key, loaded skill, and context file. This page covers what is hard to discover on your own.

## Sending input

Enter submits, and Shift+Enter or Ctrl+J inserts a newline. While a turn is running:

- **Enter steers:** the running turn takes the message at its next safe point.
- **Ctrl+Enter queues:** the message starts its own turn when the session is idle.
- **Alt+Up** cancels pending messages and puts their text back in the editor.

Escape interrupts the session, and Ctrl+C does not. Pressing Enter twice on an empty editor retries from the current history. Pressing Escape twice clears the editor.

`@src/main.ts` mentions a file and `@@skill:code-review` activates a skill. Tab completes both. Piped input becomes the first message: `printf 'summarize the changes' | tau`.

## Running commands yourself

```text
!git status --short
!!git diff --stat
```

`!` runs a command in the execution environment and adds the output to the model's context. `!!` does the same without adding anything to the context. Both need an idle session.

## Commands

| Command | Behavior |
| --- | --- |
| `/new` | Start another session in the same environment. |
| `/rewind` | Remove an earlier message and everything after it. |
| `/diff [git diff args]` | Review changes in the browser. |
| `/compact-all [guidance]` | Replace the model's context with a summary. |
| `/compact-keep-last [guidance]` | Same, keeping the last response word for word. |
| `/auto-compact [tokens\|default]` | Show or set the automatic-compaction threshold. |
| `/reload` | Reload configuration and content from the execution environment. |
| `/persona:<id>`, `/prompt:<id>`, `/theme:<id>` | Switch persona, fill the editor from a prompt, or switch theme for this run. |
| `/copy-text`, `/copy-code` | Copy from the last response. |
| `/export-response` | Send the last response to your Markdown service. |
| `/listen`, `/speak`, `/auto-speak` | Speech (macOS). |

Useful keys beyond those above: Ctrl+P cycles personas, Shift+Tab cycles reasoning, Ctrl+T shows thinking, Ctrl+S copies the draft and clears the editor. While subagents run, Alt+Down selects one and Ctrl+G interrupts it. Escape does not stop subagents.

## Diff review

`/diff` takes a Git snapshot from the execution environment and opens a browser tool on the client machine. It prepares a guide to the changes and supports comments on files and lines. Submitting adds the review to the session as a user message without starting a turn, so send a follow-up when you want the agent to act on it. The agent can open the same tool itself through `diff_review`.

## Speech

Speech works on macOS and needs `ffmpeg` (`brew install ffmpeg`). The TUI process reads the credentials, including when attached to a remote host.

- `/listen` or Ctrl+Y dictates into the editor with live transcription. Enter submits while recording, and Ctrl+Y stops without submitting. It needs `ELEVENLABS_API_KEY`. If transcription fails, the recording stays on disk, and `/listen retry` or `/listen discard` handles it.
- Tab while recording switches cleanup on or off for that recording, starting from `speech.cleanupStyle`. Cleanup needs `OPENAI_API_KEY`. It removes fillers and false starts and fixes punctuation, keeping your wording, and it sees your vocabulary and the recent conversation to fix misheard words. If cleanup fails, the raw transcript stays in the editor without being submitted.
- `/speak` reads the last response aloud, and `/auto-speak` reads each final answer. Both need `OPENAI_API_KEY` for rewriting and `ELEVENLABS_API_KEY` for audio.

Configure the voice, shortcut, cleanup style, and vocabulary in `speech`. A configured voice has no fallback, and without one Tau uses its default voices. See [configuration](configuration.md).

## Exporting a response

`/export-response` sends the last completed response to the service set in `markdownExport`:

```http
POST <url>
Authorization: Bearer <token, if configured>

{"version":1,"markdown":"# Proposal\n..."}
```

The service must answer `201` with `{"version":1,"url":"https://example.com/document/123"}`. Tau shows the URL and never retries.

## Terminal status

The TUI reports `working`, `done`, `error`, or `idle` through the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status), so a supporting terminal can show which sessions need attention. Set `PI_PROGRAM_STATUS=0` to turn this off.

## Startup flags

`--no-client-tools` stops the TUI from offering client tools, which you need when a second client attaches to the same session. `--no-agent-context-files` turns off `AGENTS.md` loading.
