# Security

A tool runs as soon as the model calls it. Tau adds no confirmation dialog, no restriction to the repository, and no general sandbox. The agent can do what the operating-system account behind the tool can do, so choose the machine and account accordingly. Use a dedicated user, container, or VM when work should be isolated.

Three things are worth keeping in mind:

- **Project content is trusted.** Opening a session in a repository loads its `.tau/` directory, skills, and `AGENTS.md`. These can add instructions and start [MCP servers](mcp.md) on the host with its credentials. A project cannot define [client tools](client-tools.md), but it can select ones you defined globally.
- **Anyone who can reach a host or bot can act through it.** A `tau serve` token gives full access to every session. A Telegram bot follows the instructions of anyone its allowlists permit. See [remote sessions](remote-sessions.md) and [Telegram](telegram.md).
- **Transcripts contain what the agent saw.** Saved sessions and [history](history.md) keep tool output, which can include source code and secrets. A remote history service holds a copy. Rotate any credential that ends up in a transcript.

Keep secrets out of project files, prompts, and model notices. Secrets in `env` or `apiKeys` are readable by anything running as that user.
