import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { resolveModel } from "../dist/core/models/catalog.js";
import { ClaudeCodeRuntime } from "../dist/core/subagents/claude_code_runtime.js";
import { spawnWithCapture } from "../dist/core/utils/spawn_capture.js";

// A protocol peer, not an Anthropic client. Exercises the shipped SDK bundle's
// initialization, deferred prompt, message decoding, and process cleanup offline.
function fakeClaude(directory, subscription, hang = false) {
  const marker = join(directory, "prompt.json");
  writeFileSync(
    join(directory, "claude"),
    `#!${process.execPath}
const readline = require("node:readline");
const fs = require("node:fs");
let initialization;
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(join(directory, "terminated"))}, "yes"); process.exit(0); });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "initialize") initialization = message.request;
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {
      commands: [], agents: [], models: [], output_style: "default", available_output_styles: [],
      account: ${JSON.stringify(subscription ? { subscriptionType: "max", apiKeySource: "none" } : { apiKeySource: "ANTHROPIC_API_KEY" })}
    } } });
  } else if (message.type === "user") {
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ message, initialization, cwd: process.cwd(), args: process.argv.slice(2) }));
    const session_id = "ce4518fa-4b3f-44ef-a1a3-2f7edc024b8d";
    send({ type: "system", subtype: "init", session_id });
    if (${hang}) { setInterval(() => {}, 1000); return; }
    send({ type: "assistant", parent_tool_use_id: null, session_id,
      message: { role: "assistant", content: [{ type: "text", text: "finished" }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }],
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } } });
    send({ type: "user", parent_tool_use_id: null, session_id, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "large-output".repeat(100000), is_error: false }
    ] } });
    send({ type: "result", subtype: "success", is_error: false, session_id, result: "finished",
      total_cost_usd: 0.01, modelUsage: { "claude-sonnet-5-5": {
        inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 7, cacheCreationInputTokens: 2, contextWindow: 1000000
      } } });
    setTimeout(() => process.exit(0), 25);
  }
});
`,
    { mode: 0o700 },
  );
  return marker;
}

function createRuntime(directory, events) {
  const model = { ...resolveModel("anthropic", "claude-sonnet-5-5"), provider: "claude-code" };
  return new ClaudeCodeRuntime({
    config: {
      model,
      settings: { reasoning: "medium" },
      systemPrompt: "subagent context",
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
          captureOutput: "combined-and-split",
        });
        return { ...result, truncated: result.captureLimitExceeded };
      },
    },
  });
}

describe("bundled Claude Agent SDK runner", () => {
  it("initializes the real SDK and sends the prompt only after subscription authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-runner-"));
    const events = [];
    const runtime = createRuntime(directory, events);
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
      expect(sent.initialization.appendSystemPrompt).toContain("subagent context");
      expect(sent.cwd).toBe(directory);
      expect(events).toContainEqual(expect.objectContaining({ type: "session" }));
      expect(events).toContainEqual({
        type: "tool",
        name: "Bash",
        subject: "npm test",
        failed: false,
      });
      expect(JSON.stringify(events)).not.toContain("large-output");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "result",
          usage: expect.objectContaining({ input: 5, contextWindowUsageTokens: 17 }),
        }),
      );
    } finally {
      runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("interrupts the SDK process group while a task is running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-interrupt-"));
    const events = [];
    const runtime = createRuntime(directory, events);
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

  it("rejects API authentication before giving the CLI a task", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-claude-auth-"));
    const events = [];
    const runtime = createRuntime(directory, events);
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
