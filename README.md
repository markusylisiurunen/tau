# tau

a terminal-based AI chat client for working with code. tau gives you access to Claude, GPT, and Gemini models, each equipped with tools to explore, write, and edit files in your project.

## getting started

tau requires Node.js 20+ and runs on macOS.

```sh
npm install
npm run build
npm start
```

or run directly from source during development:

```sh
npm run dev
```

you'll need an API key from at least one provider. set it via environment variable:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, or GOOGLE_API_KEY
```

or store keys in `~/.config/tau/config.json`:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  }
}
```

environment variables take precedence over the config file.

## risk levels

tau uses risk levels to control what the model can do. this lets you stay in control while working alongside AI.

- **none**: model can only chat, no tools available
- **read-only** (default): model can explore your codebase but can't modify anything
- **read-write**: model can create, edit, and delete files

start with a specific risk level:

```sh
tau --risk read-write
```

or change it during a session with `/risk:read-only` or `/risk:read-write`.

the default is read-only because it lets the model investigate your code and answer questions without risk of unintended changes. bump it to read-write when you're ready to let the model make edits.

## personas

tau comes with several built-in personas across different models:

- **Claude Opus 4.5** and **Haiku 4.5** (Anthropic)
- **GPT-5.2** (OpenAI)
- **Gemini 3 Pro** and **Gemini 2.5 Flash** (Google)

each model has three variants: a general-purpose assistant, a coder variant optimized for software engineering, and a raw variant with minimal prompting.

switch personas at startup with `--persona` or mid-session with `/persona:<id>`:

```sh
tau --persona opus-4.5-coder
```

## reasoning

some models support extended thinking, where they reason through problems before responding. cycle through reasoning levels with `Shift+Tab`, or set one at startup:

```sh
tau --persona opus-4.5:high
```

toggle visibility of the model's thinking with `Ctrl+T`.

## working with files

reference files in your message by typing `@` followed by the filename. autocomplete helps you find the right path. press `Ctrl+F` to expand file contents into the conversation, letting the model see the actual code.

you can also pipe content directly:

```sh
cat src/app.ts | tau --persona opus-4.5
```

for project-aware sessions, use `--with-context` to inject your AGENTS.md (or similar project guidelines file) into the system prompt. run `tau --help` to see all available options.

## memory mode

prefix a message with `#` to update your project's AGENTS.md file. this is useful for capturing decisions, conventions, and context as you work.

```
# prefer explicit error messages with context about what operation failed
```

tau will create or update AGENTS.md at your project root, integrating the new information into the existing structure. over time, this builds a knowledge base about your project. combine it with `--with-context` so future sessions understand your conventions without re-explaining them.

## commands

tau supports slash commands for common actions:

| command                | description                                  |
| ---------------------- | -------------------------------------------- |
| `/help`                | show available commands                      |
| `/new`                 | clear the session and start fresh            |
| `/copy`                | copy the last assistant message              |
| `/copy:code`           | copy just the code blocks                    |
| `/reload`              | reload personas and prompts from disk        |
| `/fork:only-summary`   | compress history and continue with a summary |
| `/fork:with-last-turn` | compress history but keep the last exchange  |
| `/persona:<id>`        | switch to a different persona                |
| `/prompt:<id>`         | insert a saved prompt template               |
| `/bash:<id>`           | run a saved shell command                    |
| `/risk:<level>`        | change the risk level                        |
| `!<cmd>`               | run a shell command directly                 |

the fork commands are useful when conversations get long. they compress everything into a summary so the model retains context without the overhead of a full history.

## keyboard shortcuts

| key         | action                      |
| ----------- | --------------------------- |
| `Shift+Tab` | cycle reasoning effort      |
| `Ctrl+T`    | toggle thinking visibility  |
| `Ctrl+O`    | toggle compact tool display |
| `Ctrl+F`    | expand @file mentions       |
| `Escape`    | interrupt generation        |
| `Ctrl+C`    | exit                        |

## configuration

### global config

store settings in `~/.config/tau/config.json`:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  },
  "toolDisplayMode": "compact",
  "userPreferences": "prefer concise responses. use TypeScript for examples."
}
```

the `userPreferences` field lets you set guidance that applies to every conversation: preferred languages, response style, or domain context.

`toolDisplayMode` controls how tool calls appear: `"compact"` (default) shows one-line summaries, `"full"` shows detailed blocks.

### project bash commands

define shortcuts for common shell commands in `.tau/config.json` at your project root (or `~/.tau/config.json` globally):

```json
{
  "bash": [
    { "id": "check", "description": "lint + typecheck", "cmd": "npm run check" },
    { "id": "test", "cmd": "npm test" }
  ]
}
```

run them with `/bash:check` or `/bash:test`.

### custom personas

create your own personas by adding markdown files to `~/.config/tau/personas/`:

```markdown
---
id: my-assistant
provider: anthropic
model: claude-opus-4-5
---

you are a helpful assistant specialized in my workflow.
focus on clarity and efficiency.
```

the frontmatter defines the persona's id, provider, and model. the markdown body becomes the system prompt. use it with `--persona my-assistant` or `/persona:my-assistant`.

### custom prompts

save reusable prompt templates in `~/.config/tau/prompts/`:

```markdown
---
id: review
---

review this code for bugs, edge cases, and style issues.
suggest specific improvements with code examples.
```

insert them with `/prompt:review`.

use `/reload` to pick up changes to personas and prompts without restarting.

## how it works

tau connects your terminal to large language models, giving them tools to interact with your filesystem. when you ask the model to explore code or make changes, it decides which tools to use and executes them with your permission (based on risk level).

the model sees your messages, any file contents you've shared, and the results of tool calls. it doesn't have ambient access to your filesystem; it only sees what you show it or what it explicitly requests through tools.

tool calls are displayed in the UI so you can see exactly what the model is doing. use `Ctrl+O` to toggle between compact and detailed views.

## creating a release

releases are published to npm automatically when a github release is published.

- make sure `package.json` has the correct version (e.g. `0.2.0`).
- run `npm run check` and `npm run build`.
- commit and push the version bump.
- create a github release with a tag matching the version (e.g. `v0.2.0`).

the workflow expects an npm token in `NPM_TOKEN` (repo settings → secrets and variables → actions).
