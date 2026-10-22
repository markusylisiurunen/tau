import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeCodeEvent,
  type ClaudeCodeInput,
  claudeCodeInputSchema,
} from "./claude_code_protocol.js";

export function claudeCodeTools(tools: string[]): string[] {
  const selected = new Set<string>();
  if (tools.includes("bash") || tools.includes("view_image")) {
    for (const name of ["Read", "Glob", "Grep"]) selected.add(name);
  }
  if (tools.includes("bash")) selected.add("Bash");
  if (tools.includes("write")) selected.add("Write");
  if (tools.includes("edit")) selected.add("Edit");
  if (tools.includes("web")) {
    selected.add("WebSearch");
    selected.add("WebFetch");
  }
  return [...selected];
}

export function claudeCodeOptions(input: ClaudeCodeInput, executable: string): Options {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_CODE_USE_") ||
      key === "CLAUDE_CODE_OAUTH_TOKEN" ||
      key === "CLAUDE_CODE_SUBAGENT_MODEL"
    )
      delete env[key];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "tau";
  const tools = claudeCodeTools(input.tools);
  return {
    cwd: input.cwd,
    model: input.model,
    effort: input.effort,
    maxTurns: 1024,
    pathToClaudeCodeExecutable: executable,
    env,
    tools,
    allowedTools: tools,
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    settings: { fastMode: false, autoMemoryEnabled: false, disableAllHooks: true },
    persistSession: true,
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        input.systemPrompt,
        "You are a background subagent working for the main Tau agent, not directly for the user.",
        "Use only the Claude Code tools available in this session. Inherited references to Tau tools or code capabilities do not make them available here.",
        "Do not launch other agents. Report questions, permission denials, and blockers to the main agent in your final response.",
        "Return a self-contained result describing the work, verification, and any remaining limitations.",
      ].join("\n\n"),
    },
    stderr: () => {},
  };
}

function findClaudeExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, "claude");
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  throw new Error(
    "Claude Code is not installed on the execution environment. Install it and sign in there with your Claude subscription before launching a Claude Code subagent.",
  );
}

export async function runClaudeCode(
  raw: unknown,
  emit: (event: ClaudeCodeEvent) => void,
): Promise<void> {
  const input = claudeCodeInputSchema.parse(raw);
  let authorized = false;
  let allowPrompt!: () => void;
  const ready = new Promise<void>((resolve) => {
    allowPrompt = resolve;
  });
  async function* prompts(): AsyncGenerator<SDKUserMessage> {
    await ready;
    if (!authorized) return;
    yield {
      type: "user",
      session_id: input.sessionId ?? "",
      parent_tool_use_id: null,
      message: { role: "user", content: input.prompt },
    };
  }
  const conversation = query({
    prompt: prompts(),
    options: claudeCodeOptions(input, findClaudeExecutable()),
  });
  const calls = new Map<string, { name: string; subject: string }>();
  let contextTokens = 0;
  try {
    const initialization = await conversation.initializationResult();
    const account = initialization.account;
    if (!account.subscriptionType || (account.apiKeySource && account.apiKeySource !== "none")) {
      throw new Error(
        "Claude Code requires a subscription login on the execution environment; API-key billing is not used by this launch model.",
      );
    }
    authorized = true;
    allowPrompt();
    for await (const message of conversation) {
      if (message.type === "system" && message.subtype === "init") {
        emit({ type: "session", id: message.session_id });
      } else if (message.type === "assistant" && message.parent_tool_use_id === null) {
        const usage = message.message.usage;
        contextTokens =
          usage.input_tokens +
          usage.output_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        for (const block of message.message.content) {
          if (block.type === "text" && block.text) {
            emit({ type: "assistant", text: block.text.slice(0, 8192) });
          } else if (block.type === "tool_use") {
            const args = block.input as Record<string, unknown>;
            const subject =
              [args.file_path, args.command, args.pattern, args.url].find(
                (value): value is string => typeof value === "string",
              ) ?? block.name;
            calls.set(block.id, {
              name: block.name.slice(0, 256),
              subject: subject.slice(0, 1024),
            });
          }
        }
      } else if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type !== "tool_result") continue;
          const call = calls.get(block.tool_use_id);
          if (!call) continue;
          calls.delete(block.tool_use_id);
          emit({ type: "tool", ...call, failed: block.is_error === true });
        }
      } else if (message.type === "result") {
        const totals = Object.values(message.modelUsage);
        const usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          contextWindowUsageTokens: contextTokens,
          contextWindow: input.contextWindow,
        };
        for (const model of totals) {
          usage.input += model.inputTokens;
          usage.output += model.outputTokens;
          usage.cacheRead += model.cacheReadInputTokens;
          usage.cacheWrite += model.cacheCreationInputTokens;
        }
        emit({
          type: "result",
          response:
            message.subtype === "success"
              ? message.result
              : [message.subtype, ...message.errors].join("\n"),
          failed: message.is_error || message.subtype !== "success",
          cost: message.total_cost_usd,
          usage,
        });
      }
    }
  } finally {
    conversation.close();
    allowPrompt();
  }
}
