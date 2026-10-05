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
tau --persona gpt-6.1-sol-coder:high
```

`-p` is the short form. `--no-agent-context-files` omits `AGENTS.md` injection and the descendant context-file scan, and `--no-client-tools` prevents the TUI from advertising its built-in and configured [client tools](client-tools.md).

Piped stdin becomes the first message in a local TUI session:

```sh
printf 'summarize the current changes' | tau
```

Use `tau attach` for a session hosted elsewhere. The terminal, themes, clipboard, speech commands, built-in diff review tool, and command-backed client tools still belong to the attaching machine. Bash tools, file access, project configuration, and model work use the session’s execution environment. See [remote sessions](remote-sessions.md) for transport and creation examples.

The startup summary lists discovered skills, project context files, configured client tools, and enabled MCP server names. MCP servers are labeled configured, not connected: connections open lazily on first use. In attached sessions, the MCP list comes from the session host. Empty sections are omitted.

## Work in the editor

Enter submits the editor. Shift+Enter or Ctrl+J inserts a newline. Up and Down move through the editor and recall prior submissions when the editor is empty.

Tau recognizes these mention forms and offers Tab completion:

- `@src/main.ts` mentions a file in the execution environment.
- `@@skill:code-review` explicitly activates an available skill.

The older `@file:`, `@skill:`, and `@agent:` forms are not mention syntax. Paths and available skill names come from the hosted session, not from the attaching TUI’s filesystem.

Typing `/` at the start of a line opens command completion. Slash commands are recognized only for single-line submissions. A multiline input beginning with `/`, or an unknown slash-prefixed input, is sent to the agent as an ordinary message.

## Submit, queue, and steer

When Tau is idle, Enter and Ctrl+Enter both start a normal turn. While a turn is active:

- Ctrl+Enter queues the text as a new turn to run when the session becomes idle.
- Enter steers the active turn. Tau applies steering at a safe continuation boundary rather than injecting it into a model response or tool execution in progress.
- Alt+Up cancels all pending queued messages and steering that has not yet been applied, then restores their text to the editor. Multiple messages are separated with `---`. Hidden guidance, such as transcription warnings, stays hidden in the pending list and editor. Restoring messages preserves their guidance in order after any guidance already attached to the draft. Submission places all guidance at the beginning of the combined message. Editing a non-empty draft preserves it; clearing the draft clears it.

Pending input is session state shared by attached clients while the host remains alive. It is not durable across host restart or session recovery. A queued turn captures the persona, reasoning, tools, and model settings when that turn actually starts. Steering remains part of the active logical turn and keeps the settings captured when that turn began.

Escape interrupts foreground client work or the main session’s active work. If a local diff review, voice input, or speech playback task owns the foreground, Escape stops that task first; otherwise it requests main-session interruption from the host, including cancellation of a running manual compaction. Once compaction has replaced model context, a late interruption does not undo it or turn successful persistence into a failure. It does not stop independently running supervised subagents; select one with Alt+Down and use Ctrl+G. Press Escape twice to clear the current editor text.

Press Enter twice on an empty editor to retry from the current session history. Retry does not rewind or duplicate the last user message.

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
/persona:opus-5.5-coder
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
| `/compact-all [guidance]` | Replace model context with a generated summary. |
| `/compact-keep-last [guidance]` | Generate a summary that also includes the previous last assistant response when available. |
| `/reload` | Reload session-owned configuration and content from the execution environment. |
| `/listen [retry/discard]` | Record speech, retry a retained failed recording, or discard it on macOS. |
| `/speak` | Read the last assistant response aloud on macOS. |
| `/auto-speak [on | off]` | Toggle automatic reading of final responses, or explicitly enable or disable it. |
| `/copy-text` | Copy the last assistant response as plain text. |
| `/copy-code` | Copy code blocks from the last assistant response. |
| `/persona:<id>` | Switch persona while idle. |
| `/prompt:<id>` | Resolve a prompt from the execution environment and place it in the editor without submitting it. |
| `/theme:<id>` | Switch this TUI’s theme for the current run. |

Commands that mutate context, such as persona changes, compaction, rewind, and reload, should be run while idle. `/auto-speak`, `/listen`, `/prompt:<id>`, and `/exit` have limited useful behavior during a running turn. Ordinary command submissions are otherwise held back until Tau is idle.

Compaction, rewind, recovery, and retry are described in [sessions](sessions.md). Prompt discovery and insertion are covered in [prompts and project context](prompts-and-project-context.md).

## Keyboard shortcuts

| Key | Behavior |
| --- | --- |
| Shift+Tab | Cycle reasoning effort. |
| Ctrl+P | Cycle persona while idle. |
| Ctrl+T | Toggle thought visibility in this TUI. |
| Ctrl+S | Copy the expanded editor contents to the local clipboard, then clear the editor. |
| Ctrl+Y | Start or stop voice recording without submitting. |
| Enter | Steer an active turn, or submit normally while idle. |
| Ctrl+Enter | Queue another turn, or submit normally while idle. |
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

Themes belong to the TUI process and never become session state. Tau’s built-in themes adapt to detected terminal appearance.

Set the startup theme with `defaultTheme` in the attaching client’s [configuration](configuration.md), or switch for the current run:

```text
/theme:gold
```

Theme ids are exact and case-sensitive. `/theme` does not persist the selection. Restart the TUI to apply a new `defaultTheme`. A remote host’s theme selection does not affect an attached client.

## Review a diff

`/diff` captures a Git snapshot through the session execution environment, then launches a diff-tool process on the TUI machine. The built-in browser tool is the review interface. `tau diff-tool` is its process entry point. `tau diff-tool --help` shows its help, while `/diff` supplies the environment required for normal reviews. Arguments are passed as Git diff arguments, for example:

```text
/diff --staged
```

Captured snapshot patches are limited to 16 MiB. Narrow the Git arguments when a larger scope is rejected. A plain working-tree snapshot includes non-binary untracked files up to 4 MiB each within that aggregate limit.

The built-in tool opens in Guide mode and starts preparing reviewer orientation, focused topics, and likely questions as soon as its shared review context is ready. Reviewers can comment on that guide, ask for another topic or question, or switch to Diff mode for file and line-level review threads. Guide comments and unresolved diff threads are included in self-contained returned Markdown that identifies the reviewed scope, gives change-level comments their relevant context, and explains the participants and roles in review discussions. Submit first opens the exact return-text preview, where included feedback can be excluded and the full review can be copied before submission. Approve returns immediately when no feedback remains; if feedback appears while approval is being checked, the preview opens instead.

The session host supplies ephemeral review agents, while the local tool owns its browser or interface process. Returned review feedback is recorded as a user entry in the session so it remains available, but Tau does not automatically start an assistant turn after the tool closes. Submit a follow-up message when the review should drive more work.

The TUI also advertises diff review as a client tool unless `--no-client-tools` is set. Manual `/diff` remains a TUI command even when model-facing client tools are disabled. See [client tools](client-tools.md) for attachment and multiple-client implications.

## Use speech

`/listen` and Ctrl+Y are currently macOS-only. Recording uses local `ffmpeg` with the AVFoundation audio input and stops when Ctrl+Y is pressed again or at the 9-minute recording limit. The Gemini limit leaves time for setup and finalization within its 10-minute live session. Startup fails if the microphone produces no audio within 15 seconds. Pressing Enter or Ctrl+Enter while recording stops capture, finishes transcription, and submits the finalized editor text. While a turn is active, Enter steers it and Ctrl+Enter queues another turn, just like normal editor submission. Pressing Ctrl+Y again or reaching the recording limit finishes transcription and inserts the transcript at the cursor for review without submitting it.

The recording shortcut is configurable with [`speech.recordingShortcut`](config-reference.md#speech), including single-press and double-tap printable keys such as `§`. The editor hint shows the configured gesture. Starting a recording stops speech playback.

`/auto-speak` toggles automatic reading of successful final answers. The command briefly confirms the selected mode; the footer does not show a persistent auto-speak indicator. `/auto-speak on` and `/auto-speak off` explicitly select the mode; turning it off also stops current playback. It starts off and applies only to the current session in this TUI, including when attached remotely. `/new` resets it. It does not change other clients or replay historical answers. Commentary, tool activity, and failed or interrupted answers are not automatically spoken. Responses arriving while recording or playing speech are not queued for later playback. Escape stops playback without disabling the mode. Automatic playback uses the same voice, credentials, and rewriting as `/speak`; it does not open the microphone or automatically submit dictation.

Gemini displays a replaceable live preview in muted italic text at the original cursor position. Automatic voice activity detection finalizes speech segments during pauses while recording continues. Tau preserves finalized segments and replaces only the current interim preview. When recording stops, Tau signals the end of audio and finishes promptly when a finalized speech activity ends at the exact end of the submitted audio and generation is complete. Otherwise, it keeps receiving live results until two seconds pass without transcription or speech-activity updates. If a new speech activity is detected after stopping, Tau signals the end of audio again to flush it. The final transcript comes from the live stream; normal recording does not upload the saved WAV for a second transcription. Finalized dictation uses normal text once transcription settles. Its final transcript replaces the preview without duplication. Submitting a draft containing finalized dictation includes hidden guidance that some or all of the message may have been transcribed from speech and may contain transcription errors. The guidance remains after edits and clears when the draft is emptied. Editing stays disabled from recording startup through finalization. Escape cancels voice input during startup, recording, microphone shutdown, transcription, or retry. Cancellation immediately removes the preview, restores the original draft, and re-enables editing without inserting or submitting speech. The cancelled recording is deleted after pending capture or file work settles. Failure also restores the original draft. Recording and retries cannot start while another editor update is pending.

A completed empty transcription inserts nothing. Tau does not detect silence locally or treat an earlier speech segment ending as completion of the whole recording. Known unfinished speech must finalize before Tau accepts the result. Live finalization has a 30-second deadline; Escape cancels this wait.

If transcription fails, Tau retains the local WAV and reports its path. Run `/listen retry` to transcribe the same audio again with Gemini and the current conversation context, or `/listen discard` to delete it. Retained recordings longer than 20 minutes are rejected rather than sent to the provider. A replacement recording deletes the retained file only after the new capture starts producing audio. Tau keeps at most one failed recording, and exiting leaves that file at the reported path for manual recovery. For live transcription, GPT-6 Luna extracts spelling hints from recent conversation while recording begins, with reasoning disabled. Tau buffers audio until the transcription session is ready and then streams subsequent audio. Gemini uses `gemini-3.5-transcribe-live` in verbatim mode with English (`en-US`) and Finnish (`fi-FI`) language hints. Missing OpenAI credentials or hint extraction failure does not fail transcription. On retry, Gemini uploads the retained recording for `gemini-3.5-transcribe` verbatim transcription with the same language hints and attempts to delete the remote file afterward.

Install `ffmpeg`:

```sh
brew install ffmpeg
```

Speech transcription uses Gemini and requires `GEMINI_API_KEY` or `apiKeys.google`. Credentials are read by the TUI process, including during remote attachment.

`/speak` is also macOS-only. It rewrites the last assistant response with GPT-6 Luna (reasoning disabled), streams Eleven v4 Turbo audio, and plays it at 1.15× speed through the local `ffplay` command included with `ffmpeg`. It requires both `OPENAI_API_KEY` or `apiKeys.openai` for rewriting and `ELEVENLABS_API_KEY` or `apiKeys.elevenlabs` for synthesis, runs only while the session is idle, and can be stopped with Escape. Longer responses are divided into balanced segments targeting at most two minutes of generated speech each. Speech source and rewritten text are limited to 10,000 Unicode characters, and generation stops after 32 MiB of raw audio. Voice lookups and synthesis requests have a two-minute deadline. See [`speech` configuration](config-reference.md#speech) for the default Maisie/Caleb lookup and custom voice selection.

## Reload the right component

Run `/reload` while idle after changing session-owned configuration, personas, prompts, skills, or AGENTS.md content in the execution environment. The host resolves them again from the session cwd, keeps the current persona when it still exists, and otherwise selects the first available persona. Warnings are shown in the transcript.

Restart the TUI instead after changing client-owned themes, the diff launcher, speech settings, or configured client tools. Effective model `apiKeys` in session configuration can update through `/reload`, and managed Codex auth storage is read again on later credential resolutions. Restart the host after changing its binary, process environment variables, WebSocket listener, or hosted execution-environment resolver configuration. [Credentials](credentials.md) has the canonical apply boundaries, and [remote sessions](remote-sessions.md) explains the component split.

## Common mistakes

- `!` and `!!` run in the execution environment, not on the attaching client.
- Enter during a turn steers it. Use Ctrl+Enter to queue another turn.
- Ctrl+T changes visibility only. Use Shift+Tab to change reasoning effort.
- `/prompt:<id>` fills the editor but does not submit it.
- `/diff` records returned feedback but does not automatically ask the assistant to act on it.
- `/reload` does not reload client themes or client tools.
- Exiting a WebSocket attachment does not delete or necessarily stop the hosted session. Exiting a local TUI shuts down its owned host, so active work is interrupted and persisted before recovery where possible.
