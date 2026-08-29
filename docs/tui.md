# Terminal interface

Tau’s terminal interface is both a local chat client and a remote session client. The same editor, commands, and review workflow are available in either mode, but their ownership matters: the session host owns conversation state and model work, while the TUI owns terminal presentation and client-local features such as themes, clipboard access, speech, and the diff-tool process.

## Start the TUI

Run `tau` in the project directory for a new local session:

```sh
cd ~/Code/tau
tau
```

Tau creates a local execution environment rooted at that directory. A startup persona and reasoning level can be selected together:

```sh
tau --persona gpt-5.6-sol-coder:high
```

`-p` is the short form. `--no-agent-context-files` omits `AGENTS.md` and explicitly configured context files, and `--no-client-tools` prevents the TUI from advertising its built-in and configured [client tools](client-tools.md).

Piped stdin becomes the first message in a local TUI session:

```sh
printf 'summarize the current changes' | tau
```

Use `tau attach` for a session hosted elsewhere. The terminal, themes, clipboard, speech commands, custom diff launcher, and command-backed client tools still belong to the attaching machine. Bash tools, file access, project configuration, and model work use the session’s execution environment. See [remote sessions](remote-sessions.md) for transport and creation examples.

## Work in the editor

Enter submits the editor. Shift+Enter or Ctrl+J inserts a newline. Up and Down move through the editor and recall prior submissions when the editor is empty.

Tau recognizes these mention forms and offers Tab completion:

- `@src/main.ts` mentions a file in the execution environment.
- `@@skill:code-review` explicitly activates an available skill.
- `@@agent:default` explicitly selects an available subagent.

The older `@file:`, `@skill:`, and `@agent:` forms are not mention syntax. Paths and available skill or agent names come from the hosted session, not from the attaching TUI’s filesystem.

Typing `/` at the start of a line opens command completion. Slash commands are recognized only for single-line submissions. A multiline input beginning with `/`, or an unknown slash-prefixed input, is sent to the agent as an ordinary message.

## Submit, queue, and steer

When Tau is idle, Enter and Ctrl+Enter both start a normal turn. While a turn is active:

- Enter queues the text as a new turn to run when the session becomes idle.
- Ctrl+Enter steers the active turn. Tau applies steering at a safe continuation boundary rather than injecting it into a model response or tool execution in progress.
- Alt+Up cancels all pending queued messages and steering that has not yet been applied, then restores their text to the editor. Multiple messages are separated with `---`.

Pending input is session state shared by attached clients while the host remains alive. It is not durable across host restart or session recovery. A queued turn captures the persona, reasoning, tools, and model settings when that turn actually starts. Steering remains part of the active logical turn and keeps the settings captured when that turn began.

Escape interrupts foreground client work or the main session’s active work. If a local diff review, recording, or speech playback task owns the foreground, Escape stops that task first; otherwise it requests main-session interruption from the host. It does not stop independently running supervised subagents; select one with Alt+Down and use Ctrl+G. Press Escape twice to clear the current editor text.

Press Enter twice on an empty editor to retry from the current session history. Retry does not rewind or duplicate the last user message. Goal-controlled turns cannot be retried; resume a blocked goal instead.

## Choose persona, reasoning, and thought visibility

The current persona and reasoning level appear in the editor header.

- `/persona:<id>` selects a persona by id.
- Ctrl+P cycles through available personas.
- Shift+Tab cycles through the current persona’s allowed reasoning levels.
- Ctrl+T shows or hides stored and streamed assistant thinking in this TUI.

Persona changes require the session to be idle because they can change the model, instructions, skills, and tools. Reasoning can be changed while a turn is running, but the active turn and its steering continuations keep their captured settings. The new reasoning level applies to the next independently started or queued turn.

Thought visibility is client-local presentation. Ctrl+T does not enable model reasoning, change its effort, or alter the session history.

For example:

```text
/persona:opus-5-coder
```

Then use Shift+Tab to select an allowed reasoning level. Newly added personas do not appear until session content has been reloaded.

## Slash commands

`/help` prints the commands, keybindings, loaded skills, and context-file paths visible to the current session.

| Command | Behavior |
| --- | --- |
| `/help` | Show commands, keys, skills, and context paths. |
| `/new` | Create a fresh session in the same execution environment, carrying over the current persona, reasoning, and conventional repository attribute. |
| `/exit` | Close this TUI. It detaches from a long-running remote host rather than deleting the session. |
| `/rewind` | Pick an earlier user message, remove it and everything after it, and return its text to the editor. |
| `/diff [git diff args...]` | Open the client-local diff review tool for a snapshot captured from the execution environment. |
| `/goal [objective\|resume\|clear]` | Show, start, resume, or clear the persistent session goal. |
| `/compact-all [guidance]` | Replace model context with a generated summary. |
| `/compact-keep-last [guidance]` | Generate a summary that also includes the previous last assistant response when available. |
| `/reload` | Reload session-owned configuration and content from the execution environment. |
| `/listen [retry/discard]` | Record speech, retry a retained failed recording, or discard it on macOS. |
| `/speak` | Read the last assistant response aloud on macOS. |
| `/copy-text` | Copy the last assistant response as plain text. |
| `/copy-code` | Copy code blocks from the last assistant response. |
| `/persona:<id>` | Switch persona while idle. |
| `/prompt:<id>` | Resolve a prompt from the execution environment and place it in the editor without submitting it. |
| `/theme:<id>` | Switch this TUI’s theme for the current run. |

Commands that mutate context, such as persona changes, compaction, rewind, and reload, should be run while idle. `/goal` display and clear, `/listen`, `/prompt:<id>`, and `/exit` have limited useful behavior during a running turn. Ordinary command submissions are otherwise held back until Tau is idle.

Compaction, rewind, goals, recovery, and retry are described in [sessions](sessions.md). Prompt discovery and insertion are covered in [prompts and project context](prompts-and-project-context.md).

## Keyboard shortcuts

| Key | Behavior |
| --- | --- |
| Shift+Tab | Cycle reasoning effort. |
| Ctrl+P | Cycle persona while idle. |
| Ctrl+T | Toggle thought visibility in this TUI. |
| Ctrl+S | Copy the expanded editor contents to the local clipboard, then clear the editor. |
| Ctrl+Y | Start or stop voice recording. |
| Ctrl+Enter | Steer an active turn, or submit normally while idle. |
| Alt+Up | Cancel pending input and restore it to the editor. |
| Alt+Down | Cycle the selected active subagent. |
| Ctrl+G | Interrupt the selected active subagent. |
| Enter twice | Retry when the editor is empty and the session is idle. |
| Escape | Interrupt foreground client or main-session work. |
| Escape twice | Clear the current editor text. |
| Ctrl+C twice | Exit the TUI. |

Ctrl+C once asks for confirmation rather than interrupting the assistant. Use Escape for interruption.

## Run direct Bash commands

A leading `!` runs a fresh non-interactive login Bash in the session execution environment without asking the model to create a tool call:

```text
!git status --short
```

The command and result are added to session context, so the agent can use them later. A double prefix runs the command without adding it to model context:

```text
!!git diff --stat
```

`!!` is useful for checks that should not consume context. Its transient card is still visible in the current TUI, but the command and output are not recorded as session conversation state.

Direct commands require the session to be idle. In an attached TUI, `!pwd` reports the execution environment’s directory, not the attaching machine’s directory. Command-backed [client tools](client-tools.md) are different: their processes run on the client machine and can explicitly request execution-environment commands through the session.

## Use themes

Themes belong to the TUI process and never become session state. Tau loads built-in themes plus JSON files from these locations:

- `~/.config/tau/themes/<id>.json` for user themes, when the TUI cwd is under the user’s home.
- `.tau/themes/<id>.json` at discovered project configuration levels, with the nearest project definition winning by id.

The filename is the theme id. A custom theme is a flat JSON object from semantic palette token names to colors:

```json
{
  "brandAccent": "#8fb3ff",
  "textMuted": "rgb(145, 151, 166)",
  "feedbackError": "hsl(354, 70%, 72%)"
}
```

Colors accept `#rgb`, `#rrggbb`, `rgb(r, g, b)`, and `hsl(h, s%, l%)`. Unknown tokens, non-string values, and invalid colors are ignored. Missing tokens render without a custom color. Custom themes are single-variant; built-in themes adapt to detected terminal appearance.

Set the startup theme with `defaultTheme` in the attaching client’s [configuration](configuration.md), or switch for the current run:

```text
/theme:gold
```

Theme ids are exact and case-sensitive. `/theme` does not persist the selection. `/reload` refreshes the hosted session, not the attaching client’s loaded theme files, so restart the TUI after adding or changing a theme. In remote use, changing theme files on the host has no effect unless the host and TUI are the same physical machine and the TUI loaded those files itself.

## Review a diff

`/diff` captures a Git snapshot through the session execution environment, then launches a diff-tool process on the TUI machine. The built-in browser tool is the default. `tau diff-tool` is the standalone command for the built-in demo and diff-review protocol reference. `tau diff-tool --help` shows its help, while `/diff` supplies the environment required for normal reviews. Arguments are passed as Git diff arguments, for example:

```text
/diff --staged
```

Captured snapshot patches are limited to 16 MiB. Narrow the Git arguments when a larger scope is rejected. A plain working-tree snapshot includes non-binary untracked files up to 4 MiB each within that aggregate limit.

A `diffTool` entry in the attaching client’s configuration replaces the launcher. Relative commands resolve from the configuration level that defines them:

```json
{
  "diffTool": {
    "command": "/usr/local/bin/team-diff-review",
    "args": ["--open"]
  }
}
```

The built-in tool opens in Guide mode and starts preparing reviewer orientation, focused topics, and likely questions as soon as its shared review context is ready. Reviewers can comment on that guide, ask for another topic or question, or switch to Diff mode for file and line-level review threads. Guide comments and unresolved diff threads are included in the returned review. Submit and Approve first open the exact return-text preview, where included feedback can be excluded and the full review can be copied before submission.

The session host supplies ephemeral review agents, while the local tool owns its browser or interface process. Returned review feedback is recorded as a user entry in the session so it remains available, but Tau does not automatically start an assistant turn after the tool closes. Submit a follow-up message when the review should drive more work.

The TUI also advertises diff review as a client tool unless `--no-client-tools` is set. Manual `/diff` remains a TUI command even when model-facing client tools are disabled. See [client tools](client-tools.md) for attachment and multiple-client implications.

## Use speech

`/listen` and Ctrl+Y are currently macOS-only. Recording uses local `ffmpeg` with the AVFoundation audio input and stops when Ctrl+Y is pressed again, when Escape is pressed, or after five minutes. Startup fails if the microphone produces no audio within 15 seconds. The transcript is inserted at the cursor for review and is not submitted automatically.

If transcription fails, Tau retains the local WAV and reports its path. Run `/listen retry` to transcribe the same audio again with the current provider and conversation context, or `/listen discard` to delete it. A replacement recording deletes the retained file only after the new capture starts producing audio. Tau keeps at most one failed recording, and exiting leaves that file at the reported path for manual recovery. For live transcription, both providers extract spelling hints from recent conversation while recording begins, buffer audio until the transcription session is ready, and then stream subsequent audio. Gemini uses Gemini 3.7 Flash for hint extraction and `gemini-3.5-transcribe-live` in smart mode; OpenAI uses GPT-5.6 Luna and `gpt-live-transcribe`. Hint extraction failure does not fail transcription. On retry, Gemini uploads the retained recording for `gemini-3.5-transcribe` smart transcription and attempts to delete the remote file afterward; OpenAI uploads it to `gpt-transcribe` with recent context.

Install `ffmpeg` and configure a speech-to-text provider:

```sh
brew install ffmpeg
```

OpenAI is the default and needs `OPENAI_API_KEY` or `apiKeys.openai`. Set `speechToText.provider` to `gemini` to use `GEMINI_API_KEY` or `apiKeys.google`. These settings and credentials are read by the TUI process, including during remote attachment.

`/speak` is also macOS-only. It rewrites the last assistant response for speech, streams audio from Gemini, and plays it through the local `ffplay` command included with `ffmpeg`. It requires `GEMINI_API_KEY` or `apiKeys.google`, runs only while the session is idle, and can be stopped with Escape. Longer responses are divided into balanced segments targeting at most two minutes of generated speech each. Speech source and rewritten text are limited to 10,000 Unicode characters, and generation stops after 32 MiB of raw audio.

## Reload the right component

Run `/reload` while idle after changing session-owned configuration, model overlays, personas, prompts, skills, or AGENTS.md content in the execution environment. The host resolves them again from the session cwd, keeps the current persona when it still exists, and otherwise selects the first available persona. Warnings are shown in the transcript.

Restart the TUI instead after changing client-owned themes, the diff launcher, speech settings, or configured client tools. Effective model `apiKeys` in session configuration can update through `/reload`, and managed Codex auth storage is read again on later credential resolutions. Restart the host after changing its binary, process environment variables, WebSocket listener, or hosted execution-environment resolver configuration. [Credentials](credentials.md) has the canonical apply boundaries, and [remote sessions](remote-sessions.md) explains the component split.

## Common mistakes

- `!` and `!!` run in the execution environment, not on the attaching client.
- Enter during a turn queues another turn. Use Ctrl+Enter to steer the active one.
- Ctrl+T changes visibility only. Use Shift+Tab to change reasoning effort.
- `/prompt:<id>` fills the editor but does not submit it.
- `/diff` records returned feedback but does not automatically ask the assistant to act on it.
- `/reload` does not reload client themes or client tools.
- Exiting a WebSocket attachment does not delete or necessarily stop the hosted session. Exiting a local TUI shuts down its owned host, so active work is interrupted and persisted before recovery where possible.
