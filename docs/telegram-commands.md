# Telegram chat commands

Send these commands to a [Telegram](telegram.md) bot from a DM or an allowed group.

## Commands

| Command | Behavior |
| --- | --- |
| `/use_<projectId>` | Selects the project for future `/new` sessions. |
| `/new` | Replaces the active session using the preferred project. |
| `/status` | Reports session state, project, model, reasoning, context usage, and cost. |
| `/persona [value]` | [Applies a persona or preset](#choose-a-persona-effort-or-prompt) while idle, without losing history or starting a turn. |
| `/effort [value]` | [Selects a reasoning level](#choose-a-persona-effort-or-prompt) for future turns. |
| `/prompt [value]` | [Records a saved prompt](prompts-and-project-context.md#telegram-prompts) while idle, without starting a turn. |
| `/auto_compact [tokens\|default]` | Shows the automatic-compaction threshold. Pass `50k` or `50000` to set it (minimum 50,000 tokens), or `default` to remove the session override and use the default. |
| `/compact` | Runs summary-only compaction while idle. |
| `/interrupt` | Interrupts the active Tau turn. |
| `/tts_on` | Sends a voice note after each final assistant response. |
| `/tts_off` | Disables voice responses. |

Changes to the auto-compaction threshold apply from the next turn and survive session recovery. `/status` shows context usage as a percentage of the full model window. When a session override is set, or the default threshold is below the model-based threshold, it also shows the effective threshold in parentheses. See [compaction thresholds](telegram.md#compaction-thresholds) for bot defaults and [automatic compaction](sessions.md#automatic-compaction) for limits and costs.

A [persona](personas.md) or preset choice applies to the current session only. `/new` starts from the bot's [`startup`](telegram.md#startup-and-presets).

Preferences are saved per bot and chat, and survive restarts and new sessions. A project change applies at the next `/new`, not to the current session.

In groups, commands must explicitly mention the bot. Accepted forms include:

```text
/status@tau_engineering_bot
/status @tau_engineering_bot
@tau_engineering_bot /status
```

Commands addressed to other bots are ignored.

## Choose a persona, effort, or prompt

`/persona`, `/effort`, and `/prompt` work the same way. Send the command alone to choose from buttons, or add a value to apply a choice directly:

| Example | Value |
| --- | --- |
| `/persona deep review` | The preset's key when the bot has `presets`, and otherwise the persona ID. |
| `/effort low` | `low`, `medium`, `high`, or `xhigh`. |
| `/prompt release-summary` | The saved prompt's ID. |

A typed value and a button follow the same rules. `/persona` and `/prompt` need an idle session. `/effort` also works during a turn: the running turn keeps its effort, and the next turn uses the new one.

`/effort` accepts only the levels in the persona's `allowedReasoningLevels` when that list is non-empty, and it has no choices for a model without reasoning.

Typed values are case-sensitive. Buttons for personas and presets show labels, and a typed value does not match a label, so use the key or ID from your configuration. A value that matches nothing changes no settings, and the bot points you to the command's buttons.

Any run of whitespace counts as one space when a value is compared, both in what you type and in the key or ID. For example, `/persona deep   review` selects the preset `deep review`. If two keys or IDs become identical this way, such as `deep review` and `deep  review`, typing that value is rejected, and the buttons still offer both.

Only the newest set of buttons for a command works. Buttons expire after a choice is applied, when the session is replaced, or when the runner restarts.
