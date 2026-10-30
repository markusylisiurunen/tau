import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgentSupervisor } from "../dist/core/subagents/agent_supervisor.js";
import { ClaudeCodeRuntime } from "../dist/core/subagents/claude_code_runtime.js";
import { spawnWithCapture } from "../dist/core/utils/spawn_capture.js";

// A protocol peer, not an Anthropic client. Exercises the shipped SDK bundle's
// initialization, deferred prompt, message decoding, and process cleanup offline.
function fakeClaude(directory, subscription, hang = false, outcome = "success") {
  const marker = join(directory, "prompt.json");
  writeFileSync(
    join(directory, "claude"),
    `#!${process.execPath}
const readline = require("node:readline");
const fs = require("node:fs");
let initialization;
let firstUuid;
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(join(directory, "terminated"))}, "yes"); process.exit(0); });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "get_context_usage") {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { totalTokens: 17, maxTokens: 1000000 } } });
      return;
    }
    if (message.request.subtype === "initialize") initialization = message.request;
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {
      commands: [], agents: [], models: [], output_style: "default", available_output_styles: [],
      account: ${JSON.stringify(subscription ? { subscriptionType: "max", apiKeySource: "none" } : { apiKeySource: "ANTHROPIC_API_KEY" })}
    } } });
  } else if (message.type === "user") {
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ message, initialization, cwd: process.cwd(), args: process.argv.slice(2) }));
    const session_id = "ce4518fa-4b3f-44ef-a1a3-2f7edc024b8d";
    send({ type: "system", subtype: "init", session_id });
    if (${JSON.stringify(hang)} === "steering" && (firstUuid || message.message.content === "initial instruction")) {
      if (!firstUuid) {
        firstUuid = message.uuid;
        send({ type: "assistant", parent_tool_use_id: null, session_id, message: { id: "first", model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "working" }], usage: { input_tokens: 1, output_tokens: 1 } } });
        return;
      }
      const finish = (uuid, text) => send({ type: "result", subtype: "success", is_error: false, session_id, result: text, total_cost_usd: 0, modelUsage: {}, user_message_uuid: uuid, user_message_uuids: [uuid] });
      if (${JSON.stringify(outcome)} !== "success") {
        send({ type: "result", subtype: "error_during_execution", is_error: true, session_id, errors: ["stopped"], total_cost_usd: 0, modelUsage: {}, user_message_uuids: [firstUuid] });
        return;
      }
      finish(firstUuid, "old result");
      setTimeout(() => {
        send({ type: "assistant", parent_tool_use_id: null, session_id, message: { id: "second", model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: message.message.content }], usage: { input_tokens: 1, output_tokens: 1 } } });
        finish(message.uuid, message.message.content);
      }, 20);
      return;
    }
    if (${JSON.stringify(hang)} === true) { setInterval(() => {}, 1000); return; }
    const stream = (event) => send({ type: "stream_event", parent_tool_use_id: null, session_id, event });
    stream({ type: "message_start", message: { id: "message-1", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } } });
    const assistant = (content, parent_tool_use_id = null) => send({ type: "assistant", parent_tool_use_id, session_id,
      message: { id: "message-1", model: "claude-sonnet-5-5", role: "assistant", content, stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } } });
    assistant([{ type: "text", text: "finished" }]);
    assistant([{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }]);
    assistant([{ type: "tool_use", id: "tool-2", name: "Read", input: null }]);
    assistant([{ type: "text", text: "nested text" }], "nested-call");
    send({ type: "user", isReplay: true, parent_tool_use_id: null, session_id, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "replay", is_error: true }
    ] } });
    send({ type: "user", parent_tool_use_id: "nested-call", session_id, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "nested result", is_error: true }
    ] } });
    send({ type: "user", parent_tool_use_id: null, session_id, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "large-output".repeat(100000), is_error: false },
      { type: "tool_result", tool_use_id: "tool-2", content: "bad input", is_error: true },
      { type: "tool_result", tool_use_id: "unknown", content: "unknown result" }
    ] } });
    stream({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3, input_tokens: null } });
    stream({ type: "message_stop" });
    if (${JSON.stringify(hang)} === "after-usage") { setInterval(() => {}, 1000); return; }
    const outcome = ${JSON.stringify(hang)} === "steering" ? "success" : ${JSON.stringify(outcome)};
    send({ type: "result", subtype: outcome === "api_error" ? "success" : outcome,
      is_error: outcome !== "success", session_id, result: "finished", errors: ["stopped"],
      total_cost_usd: 0.01, modelUsage: outcome === "error_during_execution" ? {} : {
        "claude-sonnet-5-5": { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 7, cacheCreationInputTokens: 2, contextWindow: 1000000 },
        "helper": { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 }
      } });
  }
});
`,
    { mode: 0o700 },
  );
  return marker;
}

function createRuntimeOptions(directory, events) {
  const model = { id: "claude-sonnet-5-5", provider: "claude-code" };
  return {
    config: {
      model,
      kind: "claude-code",
      effort: "medium",
      tools: ["bash"],
      workingDirectory: directory,
    },
    onEvent: async (event) => {
      events.push(event);
    },
    backend: {
      runNodeScript: async (script, args, options) => {
        const result = await spawnWithCapture(process.execPath, ["-e", script, ...args], {
          cwd: options.cwd,
          env: { ...process.env, PATH: directory },
          input: options.stdin,
          signal: options.signal,
          onOutput: options.onOutput,
          detached: true,
          killProcessGroup: true,
          killGraceMs: 100,
          timeoutMs: 15_000,
          maxCaptureBytes: options.maxCaptureBytes,
          maxCaptureMode: "ignore",
          maxCaptureStrategy: "tail",
          captureOutput: "combined-and-split",
        });
        return { ...result, truncated: result.captureLimitExceeded };
      },
    },
  };
}

describe("bundled Claude Agent SDK runner", () => {
  it.each(["success", "error_during_execution"])(
    "preserves streamed steering across an earlier %s result",
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), "tau-claude-steer-"));
      const options = createRuntimeOptions(directory, []);
      let sent = false;
      const supervisor = new AgentSupervisor({
        recordUsage: vi.fn(),
        onEvent: (event) => {
          if (event.type === "subagent_activity" && event.activity.type === "assistant" && !sent) {
            sent = true;
            expect(
              supervisor.sendInput({
                id: event.state.id,
                prompt: "updated instruction",
                mode: "steer",
              }).ok,
            ).toBe(true);
          }
        },
      });
      try {
        const marker = fakeClaude(directory, true, "steering", outcome);
        const { state } = supervisor.spawn({
          runtimeConfig: options.config,
          backend: options.backend,
          config: {},
          title: "steering test",
          prompt: "initial instruction",
          originHistoryEntryId: "origin",
        });
        const [settled] = await supervisor.waitForAgents([state.id]);
        expect(settled.run.status).toBe("succeeded");
        expect(settled.run.revision).toBe(outcome === "success" ? 1 : 2);
        expect(JSON.parse(readFileSync(marker, "utf8")).message.message.content).toBe(
          "updated instruction",
        );
        expect(supervisor.read(state.id).pending).toEqual({ queue: 0, steer: 0 });
        expect(
          supervisor
            .getTrace(state.id)
            .trace({ kinds: ["assistant"] })
            .entries.map((entry) => supervisor.getTrace(state.id).readText(entry.seq).text),
        ).toEqual(["working", outcome === "success" ? "updated instruction" : "finished"]);
      } finally {
        supervisor.reset();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("initializes the real SDK and sends the prompt only after subscription authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-runner-"));
    const events = [];
    const runtime = new ClaudeCodeRuntime(createRuntimeOptions(directory, events));
    try {
      const marker = fakeClaude(directory, true);
      const result = await runtime.submit("perform the task");
      expect(result).toMatchObject({
        status: "completed",
        result: { response: "finished", failed: false },
      });
      const sent = JSON.parse(readFileSync(marker, "utf8"));
      expect(sent.message.message.content).toBe("perform the task");
      expect(JSON.stringify(sent.args)).toContain("claude-sonnet-5-5");
      expect(sent.initialization.systemPrompt).toBeUndefined();
      expect(sent.args).toContain("--permission-mode=bypassPermissions");
      expect(sent.args).toContain("--allow-dangerously-skip-permissions");
      expect(sent.args).toContain("--setting-sources=user,project,local");
      expect(sent.args).not.toContain("--strict-mcp-config");
      expect(sent.args.some((arg) => arg.startsWith("--mcp-config"))).toBe(false);
      expect(sent.args).toContain("--tools=Read,Glob,Grep,Bash,Skill");
      expect(sent.initialization).not.toHaveProperty("skills");
      expect(sent.cwd).toBe(realpathSync(directory));
      expect(events).toContainEqual(expect.objectContaining({ type: "session" }));
      expect(events).toContainEqual({
        type: "tool",
        name: "Bash",
        subject: "npm test",
        failed: false,
      });
      expect(events.filter((event) => event.type === "tool")).toHaveLength(2);
      expect(events).toContainEqual({ type: "tool", name: "Read", subject: "Read", failed: true });
      expect(events.filter((event) => event.type === "assistant")).toEqual([
        { type: "assistant", text: "finished" },
      ]);
      expect(events.filter((event) => event.type === "trace")).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            kind: "tool_result",
            content: [{ type: "text", text: "large-output".repeat(100000) }],
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "result",
          usage: {
            input: 7,
            output: 4,
            cacheRead: 7,
            cacheWrite: 2,
            contextWindowUsageTokens: 17,
            contextWindow: 1000000,
          },
        }),
      );
    } finally {
      runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    "api_error",
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ])(
    "preserves SDK failure %s",
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), "tau-claude-failure-"));
      const events = [];
      const runtime = new ClaudeCodeRuntime(createRuntimeOptions(directory, events));
      try {
        fakeClaude(directory, true, false, outcome);
        const result = await runtime.submit("task");
        expect(result).toMatchObject({
          status: "completed",
          result: { failed: true, usage: { contextWindow: 0 } },
        });
        expect(events.filter((event) => event.type === "result")).toHaveLength(1);
        if (outcome === "error_during_execution") expect(result.result.usage.input).toBe(0);
      } finally {
        runtime.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("interrupts the SDK process group while a task is running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-interrupt-"));
    const events = [];
    const runtime = new ClaudeCodeRuntime(createRuntimeOptions(directory, events));
    let pending;
    try {
      fakeClaude(directory, true, true);
      pending = runtime.submit("wait for interruption");
      for (
        let attempt = 0;
        attempt < 500 && !events.some((event) => event.type === "session");
        attempt++
      ) {
        await setTimeout(10);
      }
      expect(events.some((event) => event.type === "session")).toBe(true);
      expect(runtime.interrupt()).toBe(true);
      expect(await pending).toEqual({ status: "interrupted" });
      expect(readFileSync(join(directory, "terminated"), "utf8")).toBe("yes");
    } finally {
      runtime.dispose();
      await pending?.catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("preserves usage in the supervisor and log when interrupted before a result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-usage-"));
    const recordUsage = vi.fn();
    const events = [];
    const supervisor = new AgentSupervisor({ recordUsage, onEvent: (event) => events.push(event) });
    const options = createRuntimeOptions(directory, []);
    let id;
    try {
      fakeClaude(directory, true, "after-usage");
      const spawned = supervisor.spawn({
        runtimeConfig: options.config,
        backend: options.backend,
        config: {},
        title: "usage test",
        prompt: "complete a model call then wait",
        originHistoryEntryId: "origin",
      });
      expect(spawned.ok).toBe(true);
      id = spawned.state.id;
      for (
        let attempt = 0;
        attempt < 500 && supervisor.getSnapshot(id).usage.output !== 3;
        attempt++
      ) {
        await setTimeout(10);
      }
      expect(supervisor.getSnapshot(id).usage.output).toBe(3);
      const stopped = await supervisor.interrupt(id);
      expect(stopped.run.status).toBe("interrupted");
      expect(stopped.usage).toEqual({
        input: 5,
        output: 3,
        cacheRead: 7,
        cacheWrite: 2,
        contextWindowUsageTokens: 17,
        contextWindow: 0,
      });
      expect(recordUsage.mock.calls.map(([entry]) => entry.usage)).toEqual([
        { input: 5, output: 0, cacheRead: 7, cacheWrite: 2, total: 14 },
        { input: 0, output: 3, cacheRead: 0, cacheWrite: 0, total: 3 },
      ]);
      expect(stopped.costTotal).toBe(0);
      expect(readFileSync(join(directory, "terminated"), "utf8")).toBe("yes");
    } finally {
      if (id) await supervisor.interrupt(id);
      supervisor.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects API authentication before giving the CLI a task", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-auth-"));
    const events = [];
    const runtime = new ClaudeCodeRuntime(createRuntimeOptions(directory, events));
    try {
      const marker = fakeClaude(directory, false);
      await expect(runtime.submit("must not run")).rejects.toThrow(/subscription/);
      expect(() => readFileSync(marker)).toThrow();
      expect(events).toEqual([]);
    } finally {
      runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
