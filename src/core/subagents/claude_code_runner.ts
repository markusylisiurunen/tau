import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import {
  type Options,
  query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeCodeEvent,
  type ClaudeCodeInput,
  claudeCodeInputSchema,
} from "./claude_code_protocol.js";
import { boundedTraceBlocks, traceBlocks } from "./trace.js";

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
  const tools = [...claudeCodeTools(input.tools), "Skill"];
  return {
    cwd: input.cwd,
    model: input.model,
    effort: input.effort,
    maxTurns: 1024,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: executable,
    env,
    tools,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: ["Agent", "Task", "AskUserQuestion"],
    settingSources: ["user", "project", "local"],
    skills: "all",
    settings: {
      fastMode: false,
      autoMemoryEnabled: false,
      disableAllHooks: true,
      sandbox: { enabled: false },
    },
    persistSession: true,
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        "You are a headless subagent supporting a parent agent. Complete the assigned task autonomously, including any verification it requires. No user or parent agent is available to answer questions or approve intermediate steps. Resolve minor ambiguities with reasonable assumptions and continue. If missing information or authority prevents safe progress, report the blocker clearly instead of attempting brittle or risky workarounds. Later user messages also come from the parent agent: they may change the task you are working on or give you a new one.",
        "Read and follow applicable project instructions wherever you work. Use the skills available in this session when relevant.",
        "Other agents may be modifying the same worktree. Never revert, discard, or overwrite changes you did not make. Avoid mutating Git operations unless explicitly instructed by the task. Do not launch other agents.",
        "Your final response is what the parent agent receives from your work. Make it self-contained and include everything important for the parent to understand and use the result. Do not rely on intermediate messages or tool output being visible.",
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
  send: (event: ClaudeCodeEvent) => void,
  directory: string,
): Promise<void> {
  const emit = (event: ClaudeCodeEvent) => {
    if (event.type === "trace") {
      if ("content" in event.event) event.event.content = boundedTraceBlocks(event.event.content);
      else event.event.arguments = boundedTraceBlocks(event.event.arguments);
    }
    send(event);
  };
  const input = claudeCodeInputSchema.parse(raw);
  let authorized = false;
  let allowPrompt!: () => void;
  const ready = new Promise<void>((resolve) => {
    allowPrompt = resolve;
  });
  let finishPrompt!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  const pending: { message: string; uuid: ReturnType<typeof randomUUID> }[] = [];
  const outstanding = new Set<string>();
  let wake: (() => void) | undefined;
  let closing = false;
  const socketPath = join(directory, "input.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (!buffer.endsWith("\n")) return;
      try {
        const value = JSON.parse(buffer);
        if (closing || typeof value.message !== "string" || outstanding.size >= 64) {
          socket.end("closed\n");
          return;
        }
        const uuid = randomUUID();
        pending.push({ message: value.message, uuid });
        outstanding.add(uuid);
        wake?.();
        socket.end("accepted\n");
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  async function* prompts(): AsyncGenerator<SDKUserMessage> {
    await ready;
    if (!authorized) return;
    yield {
      type: "user",
      uuid: randomUUID(),
      session_id: input.sessionId ?? "",
      parent_tool_use_id: null,
      message: { role: "user", content: input.prompt },
    };
    while (!closing) {
      if (!pending.length)
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          finished,
        ]);
      wake = undefined;
      const next = pending.shift();
      if (next)
        yield {
          type: "user",
          uuid: next.uuid,
          session_id: input.sessionId ?? "",
          parent_tool_use_id: null,
          message: { role: "user", content: next.message },
        };
    }
  }
  let conversation: ReturnType<typeof query> | undefined;
  const calls = new Map<string, { name: string; subject: string }>();
  let streamedMessage: Pick<SDKAssistantMessage["message"], "id" | "usage"> | undefined;
  const emitUsage = (message: Pick<SDKAssistantMessage["message"], "id" | "usage">) => {
    emit({
      type: "usage",
      messageId: message.id,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      },
    });
  };
  try {
    conversation = query({
      prompt: prompts(),
      options: claudeCodeOptions(input, findClaudeExecutable()),
    });
    const initialization = await conversation.initializationResult();
    const account = initialization.account;
    if (!account.subscriptionType || (account.apiKeySource && account.apiKeySource !== "none")) {
      throw new Error(
        "Claude Code requires a subscription login on the execution environment; API-key billing is not used by this launch model.",
      );
    }
    emit({ type: "control", path: socketPath });
    authorized = true;
    allowPrompt();
    for await (const message of conversation) {
      if (message.type === "system" && message.subtype === "init") {
        emit({ type: "session", id: message.session_id });
      } else if (message.type === "system" && message.subtype === "compact_boundary") {
        emit({
          type: "trace",
          event: { kind: "notice", code: "compaction.compacted", content: [] },
        });
      } else if (message.type === "stream_event" && message.parent_tool_use_id === null) {
        const event = message.event;
        if (event.type === "message_start") {
          streamedMessage = { id: event.message.id, usage: event.message.usage };
        } else if (event.type === "message_delta" && streamedMessage) {
          const usage = streamedMessage.usage;
          streamedMessage.usage = {
            ...usage,
            input_tokens: event.usage.input_tokens ?? usage.input_tokens,
            output_tokens: event.usage.output_tokens ?? usage.output_tokens,
            cache_read_input_tokens:
              event.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
            cache_creation_input_tokens:
              event.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens,
          };
          emitUsage(streamedMessage);
        } else if (event.type === "message_stop") {
          streamedMessage = undefined;
        }
      } else if (message.type === "assistant" && message.parent_tool_use_id === null) {
        emitUsage(message.message);
        const content = message.message.content.filter((block) => block.type === "text");
        if (content.length)
          emit({ type: "trace", event: { kind: "assistant", content: traceBlocks(content) } });
        for (const block of message.message.content) {
          if (block.type === "text" && block.text) {
            emit({ type: "assistant", text: block.text.slice(0, 8192) });
          } else if (block.type === "tool_use") {
            const args =
              block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)
                ? (block.input as Record<string, unknown>)
                : {};
            const subject =
              [args.file_path, args.command, args.pattern, args.url].find(
                (value): value is string => typeof value === "string",
              ) ?? block.name;
            emit({
              type: "trace",
              event: {
                kind: "tool_call",
                callId: block.id,
                toolName: block.name,
                arguments: [{ type: "json", value: JSON.parse(JSON.stringify(block.input)) }],
              },
            });
            calls.set(block.id, {
              name: block.name.slice(0, 256),
              subject: subject.slice(0, 1024),
            });
          }
        }
      } else if (
        message.type === "user" &&
        !("isReplay" in message && message.isReplay) &&
        message.parent_tool_use_id === null &&
        Array.isArray(message.message.content)
      ) {
        for (const block of message.message.content) {
          if (block.type !== "tool_result") continue;
          const call = calls.get(block.tool_use_id);
          if (!call) continue;
          calls.delete(block.tool_use_id);
          emit({ type: "tool", ...call, failed: block.is_error === true });
          emit({
            type: "trace",
            event: {
              kind: "tool_result",
              callId: block.tool_use_id,
              toolName: call.name,
              outcome: block.is_error ? "failed" : "succeeded",
              content: traceBlocks(block.content),
            },
          });
        }
      } else if (message.type === "result") {
        for (const uuid of message.user_message_uuids ??
          (message.user_message_uuid ? [message.user_message_uuid] : []))
          outstanding.delete(uuid);
        if (outstanding.size && !message.user_message_uuid && !message.user_message_uuids)
          throw new Error(
            "Claude Code did not report streamed input consumption; update the Claude CLI before steering workers.",
          );
        closing = message.is_error || message.subtype !== "success" || outstanding.size === 0;
        const totals = Object.values(message.modelUsage);
        const failed = message.is_error || message.subtype !== "success";
        const context = failed
          ? undefined
          : await conversation.getContextUsage({ detail: "summary" });
        const usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          contextWindowUsageTokens: context?.totalTokens ?? 0,
          contextWindow: context?.maxTokens ?? 0,
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
          failed,
          cost: message.total_cost_usd,
          usage,
        });
        if (closing) return;
      }
    }
  } finally {
    closing = true;
    finishPrompt();
    server.close();
    conversation?.close();
    allowPrompt();
  }
}
