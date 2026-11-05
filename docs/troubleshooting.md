# Troubleshooting

Most problems come from a setting on the wrong machine or a change that has not been applied. Start by finding which part reads the setting, using [how Tau works](how-tau-works.md).

## Inspecting state

- `tau --debug --persona <id>` prints what a new local session would load, including the full prompt, and exits. Keep the output private. It cannot inspect a remote host.
- `/help` shows the loaded skills, context files, and client tools of the current session.
- `/reload` reports configuration warnings for the current session.
- `!!pwd`, `!!printf '%s\n' "$HOME"`, and `!!command -v git` show what the agent sees, without using context.
- `tau auth list` shows Codex accounts on the host.

No command prints the complete effective configuration.

## A configuration change has no effect

Check these in order:

1. You edited the file on the machine that reads it.
2. The working directory is inside home if you edited global configuration.
3. A nearer project level does not override the field.
4. You spelled the field correctly, because Tau removes unknown fields without a warning.
5. You applied the change. See [configuration](configuration.md).

An invalid value is skipped with a warning, so a value from a broader level may still apply.

## A tool is missing

Check the active persona's `tools` list, which replaces the defaults. Client tools come from an attached client, so check [client tools](client-tools.md) for those. MCP is unavailable in sessions on a remote execution environment. Missing credentials make a tool fail without removing it.

## A credential is rejected

Find the process making the request. A key exported on a laptop does not reach a remote host, and the agent's Bash commands do not inherit variables with credential-like names. After changing environment variables or `apiKeys`, restart the process. See [models and credentials](models-and-credentials.md).

## Commands hang or print unexpected text

Every command runs in a fresh non-interactive login Bash with no terminal. Test startup with `!!bash -lc 'printf ok'`. If the output has anything beyond `ok`, look at `/etc/profile`, your login files, and `BASH_ENV`. Set up Git and SSH so they work without prompts.

## A session is missing or will not recover

The host lists only sessions it can reconnect. Check that you run the same OS user and Tau version or newer, and that the directory, Sprite, and host configuration still exist. Keep the session file and the error message, and never edit session files. See [sessions](sessions.md).
