# Terminal interface

Tau's terminal interface works both for local sessions and for sessions on a remote host. The editor, commands, and review workflow are the same in both. The session host holds the conversation and runs the model, while the TUI handles the terminal and local features such as themes, the clipboard, speech, and the diff tool.

## Start the TUI

Run `tau` in the project directory to start a new local session:

```sh
cd ~/Code/tau
tau
```

The agent works in that directory. You can choose a persona and reasoning level at startup:

```sh
tau --persona gpt-6.1-sol-coder:high
```

`-p` is the short form. `--no-agent-context-files` turns off `AGENTS.md` loading and the scan for nested `AGENTS.md` files. `--no-client-tools` stops the TUI from offering its built-in and configured [client tools](client-tools.md).

Piped stdin becomes the first message of a local session:

```sh
printf 'summarize the current changes' | tau
```

Use `tau attach` for a session hosted elsewhere. The terminal, themes, clipboard, speech commands, built-in diff review tool, and command client tools stay on the attaching machine. Bash tools, file access, project configuration, and model calls use the session's execution environment. See [remote sessions](remote-sessions.md) for connecting and creating sessions.

The startup summary lists discovered skills, project context files, configured client tools, and enabled MCP servers. MCP servers are shown as configured, not connected, because connections open on first use. In attached sessions, the MCP list comes from the host. Empty sections are left out.

## Work in the editor

Enter submits. Shift+Enter or Ctrl+J inserts a newline. Up and Down move within the editor, and recall earlier submissions when the editor is empty.

Tau recognizes these mentions and completes them with Tab:

- `@src/main.ts` mentions a file in the execution environment.
- `@@skill:code-review` explicitly activates an available skill.

Other forms, such as `@file:`, `@skill:`, or `@agent:`, are not mentions. File paths and skill names come from the session, not from the attaching machine's filesystem.

Typing `/` at the start of a line opens command completion. Slash commands work only in single-line submissions. Multiline input that starts with `/`, and unknown slash commands, are sent to the agent as ordinary messages.

## Submit, queue, and steer

When Tau is idle, Enter and Ctrl+Enter both start a normal turn. While a turn is running:

- Ctrl+Enter queues the text as a new turn that runs when the session becomes idle.
- Enter steers the running turn. Tau applies steering at the next safe point, never in the middle of a model response or tool call.
- Alt+Up cancels all queued messages and steering not yet applied, and puts their text back in the editor, separated by `---`.

Some messages carry hidden guidance, such as a note that text was transcribed from speech. Hidden guidance stays hidden in the pending list and the editor. When messages are restored, their guidance is kept, in order, after any guidance the draft already has. On submission, all guidance goes at the start of the combined message. Editing a non-empty draft keeps its guidance, and clearing the draft removes it.

Pending input is shared by all clients attached to the session while the host keeps running. It is not saved and is lost when the host restarts. A queued turn uses the persona, reasoning, tools, and model settings current when it actually starts. Steering belongs to the running turn and uses the settings that turn started with.

Escape interrupts work. If local work is in the foreground, such as diff review, voice input, or speech playback, Escape stops that first. Otherwise it asks the host to interrupt the session, which also cancels a running manual compaction. Once compaction has replaced the context, a late interruption does not undo it or turn the saved result into a failure. Escape does not stop subagents; select one with Alt+Down and press Ctrl+G. Press Escape twice to clear the editor.

Press Enter twice on an empty editor to retry from the current history. Retry does not rewind or repeat the last user message.

## Choose persona, reasoning, and thought visibility

The editor header shows the current persona and reasoning level.

- `/persona:<id>` selects a persona by ID.
- Ctrl+P cycles through available personas.
- Shift+Tab cycles through the persona's allowed reasoning levels.
- Ctrl+T shows or hides the assistant's thinking in this TUI.

Persona changes require an idle session, because they can change the model, instructions, skills, and tools. Reasoning can change while a turn is running, but that turn and its steering keep their settings. The new level applies from the next turn.

Ctrl+T affects only what this TUI displays. It does not turn on reasoning, change its effort, or change the session history.

For example:

```text
/persona:opus-5.5-coder
```

Then use Shift+Tab to choose a reasoning level. A newly added persona appears only after `/reload`.

## Slash commands

`/help` prints the commands, keybindings, loaded skills, and context file paths for the current session.

| Command | Behavior |
| --- | --- |
| `/help` | Show commands, keys, skills, and context paths. |
| `/new` | Create a new session in the same execution environment, keeping the current persona, reasoning, and `repository` attribute. |
| `/exit` | Close this TUI. On a long-running remote host, this detaches; the session is not deleted. |
| `/rewind` | Pick an earlier user message, remove it and everything after it, and put its text back in the editor. |
| `/diff [git diff args...]` | Open the local diff review tool on a snapshot taken from the execution environment. |
| `/compact-all [guidance]` | Replace the model's context with a generated summary. |
| `/compact-keep-last [guidance]` | Same, and include the last assistant response in the summary when there is one. |
| `/reload` | Reload session configuration and content from the execution environment. |
| `/listen [retry/discard]` | Record speech, or retry or discard a failed recording. macOS only. |
| `/speak` | Read the last assistant response aloud. macOS only. |
| `/auto-speak [on | off]` | Toggle automatic reading of final responses, or turn it on or off. |
| `/copy-text` | Copy the last assistant response as plain text. |
| `/copy-code` | Copy the code blocks from the last assistant response. |
| `/persona:<id>` | Switch persona while idle. |
| `/prompt:<id>` | Load a prompt from the execution environment into the editor without sending it. |
| `/theme:<id>` | Switch this TUI's theme until it exits. |

Run commands that change the context, such as persona changes, compaction, rewind, and reload, while idle. `/auto-speak`, `/listen`, `/prompt:<id>`, and `/exit` do little during a running turn. Other commands wait until Tau is idle.

[Sessions](sessions.md) describes compaction, rewind, recovery, and retry. [Prompts and project context](prompts-and-project-context.md) covers prompt files.

## Keyboard shortcuts

| Key | Behavior |
| --- | --- |
| Shift+Tab | Cycle reasoning effort. |
| Ctrl+P | Cycle persona while idle. |
| Ctrl+T | Show or hide thinking in this TUI. |
| Ctrl+S | Copy the expanded editor contents to the clipboard, then clear the editor. |
| Ctrl+Y | Start or stop voice recording without submitting. |
| Enter | Steer a running turn, or submit while idle. |
| Ctrl+Enter | Queue another turn, or submit while idle. |
| Alt+Up | Cancel pending input and put it back in the editor. |
| Alt+Down | Select the next running subagent. |
| Ctrl+G | Interrupt the selected subagent. |
| Enter twice | Retry, when the editor is empty and the session is idle. |
| Escape | Interrupt local work or the session. |
| Escape twice | Clear the editor. |
| Ctrl+C twice | Exit the TUI. |

A single Ctrl+C asks for confirmation; it does not interrupt the assistant. Use Escape to interrupt.

## Run Bash commands directly

A leading `!` runs a command in a fresh non-interactive login Bash in the execution environment, without going through the model:

```text
!git status --short
```

The command and its output are added to the session, so the agent can use them later. A double `!!` runs the command without adding it to the model's context:

```text
!!git diff --stat
```

Use `!!` for checks that should not use up context. Its card still appears in the current TUI, but the command and output are not saved in the conversation.

Direct commands require an idle session. In an attached TUI, `!pwd` shows the execution environment's directory, not the attaching machine's. Command [client tools](client-tools.md) are different: they run on the client machine and can ask the session to run commands in the execution environment.

## Use themes

Themes belong to the TUI and are never saved in the session. Tau's built-in themes adapt to the terminal's light or dark appearance.

Set the startup theme with `defaultTheme` in the client's [configuration](configuration.md), or switch for the current run:

```text
/theme:gold
```

Theme IDs are exact and case-sensitive. `/theme` does not save the choice. Restart the TUI to apply a new `defaultTheme`. A remote host's theme setting does not affect attached clients.

## Review a diff

`/diff` takes a Git snapshot in the execution environment, then opens the built-in browser review tool on the TUI machine. Arguments are passed to `git diff`, for example:

```text
/diff --staged
```

`tau diff-tool` is the tool's own command, and `tau diff-tool --help` shows its help, but normal reviews start from `/diff`, which sets up its environment.

A snapshot's patch can be at most 16 MiB. Narrow the Git arguments if a larger diff is rejected. A plain working-tree snapshot includes non-binary untracked files of up to 4 MiB each, within that total.

The tool has two views:

- **Guide** explains the change through an orientation and focused topics. The tool starts preparing it as soon as the review context is ready.
- **Diff** shows the files and lines.

Feedback comes in two forms, and both can be attached to a diff line, a guide section, or the whole change:

- **Comments** are notes for the author and are always part of the returned review.
- **Conversations** are questions to a review agent. They stay private unless you include them, in which case their transcript is returned as context.

The review panel lists all comments and conversations in either view and jumps to where each was left. **Finish review** shows what will be returned and can display the full Markdown before you submit. Finishing with no comments or included conversations approves the change. The returned Markdown stands on its own: it names the reviewed scope and quotes the guide content each guide comment refers to.

The session host provides temporary review agents, and the local tool runs the browser interface. The returned review is added to the session as a user message, but Tau does not start an assistant turn when the tool closes. Send a follow-up message when the review should lead to more work.

The TUI also offers diff review to the agent as a client tool, unless `--no-client-tools` is set. `/diff` works either way. See [client tools](client-tools.md) for what this means with several clients.

## Use speech

### Dictation

`/listen` and Ctrl+Y work only on macOS. Recording uses the local `ffmpeg` with AVFoundation audio input. It stops when you press Ctrl+Y again or after 9 minutes, which leaves time to finish within Gemini's 10-minute live session. Startup fails if the microphone gives no audio within 15 seconds.

- Enter or Ctrl+Enter while recording stops capture, finishes transcription, and submits the editor text. While a turn is running, Enter steers and Ctrl+Enter queues, as usual.
- Ctrl+Y, or reaching the time limit, finishes transcription and inserts the transcript at the cursor without submitting it.

The shortcut can be changed with [`speech.recordingShortcut`](config-reference.md#speech), including single-press or double-tap printable keys such as `§`. The editor hint shows the configured gesture. Starting a recording stops speech playback.

While you speak, Gemini shows a live preview in muted italics at the cursor. During pauses, Gemini finalizes segments of speech while recording continues. Tau keeps finalized segments and replaces only the current preview. After recording stops:

- Tau tells Gemini the audio has ended. It finishes right away if a finalized segment ends exactly at the end of the audio and generation is complete.
- Otherwise it keeps receiving results until two seconds pass with no updates. If new speech is detected after stopping, Tau signals the end of audio again to flush it.
- The final transcript comes from the live stream. Normal recordings are not uploaded again for a second transcription.
- Unfinished speech must be finalized before Tau accepts the result. Finalization has a 30-second deadline, and Escape cancels the wait.

The final transcript replaces the preview in normal text, without duplication. An empty transcript inserts nothing. Tau does not detect silence locally, and the end of one speech segment does not count as the end of the recording.

A submitted draft that contains dictation carries hidden guidance saying that some or all of the message may have been transcribed from speech and may contain errors. The guidance survives edits and is removed when the draft is emptied.

The editor is locked from the start of recording until finalization. Escape cancels voice input at any stage: startup, recording, microphone shutdown, transcription, or retry. Cancelling removes the preview at once, restores the original draft, and unlocks the editor without inserting or submitting anything. The cancelled recording is deleted once pending file work finishes. A failure also restores the original draft. A recording or retry cannot start while another editor update is pending.

For live transcription, GPT-6 Luna, with reasoning disabled, extracts spelling hints from the recent conversation while recording starts. Tau buffers audio until the transcription session is ready, then streams it. Gemini uses `gemini-3.5-transcribe-live` in verbatim mode with English (`en-US`) and Finnish (`fi-FI`) language hints. Missing OpenAI credentials or a failed hint extraction do not stop transcription.

If transcription fails, Tau keeps the local WAV file and reports its path:

- `/listen retry` transcribes the same audio again with Gemini and the current conversation context. Gemini uploads the file for `gemini-3.5-transcribe` verbatim transcription with the same language hints, and Tau tries to delete the uploaded file afterward. Recordings longer than 20 minutes are rejected instead of being sent.
- `/listen discard` deletes the file.

Tau keeps at most one failed recording. A new recording deletes it only once the new capture is producing audio. Exiting leaves the file at the reported path so you can recover it.

Install `ffmpeg`:

```sh
brew install ffmpeg
```

Transcription uses Gemini and needs `GEMINI_API_KEY` or `apiKeys.google`. The TUI process reads these credentials, also when attached to a remote host.

### Reading responses aloud

`/speak` also works only on macOS. It rewrites the last assistant response with GPT-6 Luna (reasoning disabled), streams Eleven v4 Turbo audio, and plays it at 1.15× speed through `ffplay`, which comes with `ffmpeg`.

- It needs `OPENAI_API_KEY` or `apiKeys.openai` for rewriting, and `ELEVENLABS_API_KEY` or `apiKeys.elevenlabs` for synthesis.
- It runs only while the session is idle. Escape stops it.
- Longer responses are split into balanced parts, each aiming for at most two minutes of speech.
- The source and rewritten text are limited to 10,000 Unicode characters, and generation stops after 32 MiB of raw audio.
- Voice lookups and synthesis requests have a two-minute deadline.

See [`speech` configuration](config-reference.md#speech) for the default Maisie and Caleb voices and for choosing your own.

`/auto-speak` toggles automatic reading of successful final answers, and briefly confirms the new mode. `/auto-speak on` and `/auto-speak off` set it explicitly, and turning it off also stops current playback.

- It starts off and applies only to the current session in this TUI, also when attached remotely. `/new` turns it off.
- It does not affect other clients or read earlier answers.
- Commentary, tool activity, and failed or interrupted answers are not read.
- Answers that arrive while recording or playing speech are not saved for later playback.
- Escape stops playback without turning the mode off.
- It uses the same voice, credentials, and rewriting as `/speak`. It never opens the microphone or submits dictation.

## Reload the right component

Run `/reload` while idle after changing configuration, personas, prompts, skills, or `AGENTS.md` content in the execution environment. The host reads them again from the session's working directory, keeps the current persona if it still exists, and otherwise selects the first available persona. Warnings appear in the transcript.

Restart the TUI instead after changing themes, the diff tool, speech settings, or configured client tools. Codex auth storage is read again on every new request. Restart the host after changing its Tau version, environment variables, `apiKeys`, WebSocket listener, or hosted execution environment settings. [Credentials](credentials.md) and [remote sessions](remote-sessions.md) explain which process owns what.

## Common mistakes

- `!` and `!!` run in the execution environment, not on the attaching machine.
- Enter during a turn steers it. Use Ctrl+Enter to queue another turn.
- Ctrl+T changes only what is displayed. Use Shift+Tab to change reasoning effort.
- `/prompt:<id>` fills the editor but does not send it.
- `/diff` adds the returned review to the session but does not ask the assistant to act on it.
- `/reload` does not reload client themes or client tools.
- Exiting a WebSocket attachment does not delete the session and does not necessarily stop it. Exiting a local TUI shuts down its host, so running work is interrupted and saved where possible.
