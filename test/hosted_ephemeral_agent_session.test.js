import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { LocalExecutionEnvironment } from "../dist/execution/local_execution_environment.js";
import { HostedEphemeralAgentSession } from "../dist/host/hosted_ephemeral_agent_session.js";

function createAssistant(text) {
  const model = personas[0].model;
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
    timestamp: Date.now(),
  };
}

function createStream(message) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return message;
    },
  };
}

function createFailingStream(partialText, error) {
  const partial = createAssistant(partialText);
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: partialText, partial };
      throw error;
    },
    async result() {
      throw error;
    },
  };
}

function createSession(recordUsage = vi.fn(), config = {}, reasoning = "medium") {
  const backend = createLocalToolExecutionBackend();
  const executionEnvironment = {
    snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
    getToolExecutionBackend: () => backend,
    resolveRuntimeContext: async ({ cwd, includeAgentContext }) => ({
      promptBootstrap: {
        promptContext: {
          cwd,
          home: "/home/user",
          repoRoot: "/repo",
          platform: "linux",
          includeAgentContext,
        },
        agentsFiles: [],
        warnings: [],
      },
    }),
  };
  const emitUpdate = vi.fn();
  return {
    emitUpdate,
    recordUsage,
    session: new HostedEphemeralAgentSession({
      cwd: "/repo",
      contextId: "ephemeral-1",
      sessionId: "session-1",
      sessionStartedAt: 0,
      persona: personas[0],
      config,
      discoveredSkills: [],
      includeAgentContext: false,
      executionEnvironment,
      instructions: "review the diff",
      tools: [],
      reasoning,
      emitUpdate,
      recordUsage,
    }),
  };
}

describe("HostedEphemeralAgentSession", () => {
  it("uses the review directory for instructions, skills, and Bash in new and forked threads", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "tau-review-context-")));
    const parent = join(home, "a");
    const cwd = join(parent, "repo");
    await mkdir(join(cwd, ".git"), { recursive: true });
    await mkdir(join(cwd, ".agents", "skills", "review-fixture"), { recursive: true });
    await writeFile(join(parent, "AGENTS.md"), "parent-context-marker");
    await writeFile(join(cwd, "AGENTS.md"), "review-context-marker");
    await writeFile(
      join(cwd, ".agents", "skills", "review-fixture", "SKILL.md"),
      "---\nname: review-fixture\ndescription: review-skill-marker\n---\nReview fixture.\n",
    );
    const environment = new LocalExecutionEnvironment({
      cwd: parent,
      home,
      backend: createLocalToolExecutionBackend(),
    });
    const session = new HostedEphemeralAgentSession({
      cwd,
      contextId: "ephemeral-1",
      sessionId: "session-1",
      sessionStartedAt: 0,
      persona: personas[0],
      config: {},
      discoveredSkills: [],
      includeAgentContext: true,
      executionEnvironment: environment,
      instructions: "review the diff",
      tools: ["bash"],
      reasoning: "medium",
      emitUpdate: vi.fn(),
      recordUsage: vi.fn(),
    });
    try {
      for (const [id, source] of [["guide"], ["discussion"], ["fork", "guide"]]) {
        const thread = await session.getOrCreateThread(id, source);
        expect(thread.runtime.spec.systemPrompt).toContain("review-context-marker");
        expect(thread.runtime.spec.systemPrompt).toContain("review-skill-marker");
        const result = await thread.runtime.spec.tools.get("bash").execute(
          { id: "pwd", name: "bash", arguments: { command: "pwd" } },
          {
            agentId: id,
            turnId: "turn",
            assistantMessageId: "message",
            signal: new AbortController().signal,
            emitActivity: async () => {},
          },
        );
        expect(result.outcome).toBe("succeeded");
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: expect.stringContaining(cwd) }),
          ]),
        );
      }
      expect(environment.snapshot().cwd).toBe(parent);
      const result = await environment.getToolExecutionBackend().runBash("pwd");
      expect(result.stdout.trim()).toBe(parent);
    } finally {
      session.dispose();
      await environment.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves native instructions and metadata when forking without sending metadata to the model", async () => {
    const { session } = createSession();
    try {
      const source = await session.getOrCreateThread("source");
      await source.runtime.commitSystemMessage("fork instruction", {
        type: "instruction",
        version: 1,
      });
      const fork = await session.getOrCreateThread("fork", "source");
      expect(fork.runtime.rawHistory).toEqual(source.runtime.rawHistory);
      const stream = vi.fn(() => createStream(createAssistant("done")));
      fork.runtime.spec.model.stream = stream;
      await session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "fork",
        message: "continue",
      });
      const message = stream.mock.calls[0][0].messages.find((entry) => entry.role === "system");
      expect(message.content).toBe("fork instruction");
      expect(message).not.toHaveProperty("metadata");
      expect(fork.runtime.rawHistory.find((entry) => entry.role === "system").metadata).toEqual({
        type: "instruction",
        version: 1,
      });
    } finally {
      await session.dispose();
    }
  });

  it("continues and forks thread state", async () => {
    const { session, recordUsage, emitUpdate } = createSession(vi.fn(), {}, "low");
    const source = await session.getOrCreateThread("source");
    expect(source.runtime).toBeInstanceOf(AgentRuntime);
    expect(source.runtime.spec.attribution.reasoningEffort).toBe("low");
    const sourceResponses = [createAssistant("first"), createAssistant("continued")];
    source.runtime.spec.model.stream = vi.fn(() => createStream(sourceResponses.shift()));

    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "source",
        message: "first request",
        reasoning: "high",
      }),
    ).resolves.toEqual({ threadId: "source", response: "first" });
    expect(source.runtime.spec.attribution.reasoningEffort).toBe("high");
    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "source",
        message: "continue",
      }),
    ).resolves.toEqual({ threadId: "source", response: "continued" });
    expect(source.runtime.spec.attribution.reasoningEffort).toBe("high");

    const inheritedFork = await session.getOrCreateThread("inherited-fork", "source");
    expect(inheritedFork.runtime.spec.attribution.reasoningEffort).toBe("high");

    source.runtime.spec.model.stream = vi.fn(() => createStream(createAssistant("forked")));
    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "fork",
        forkFromThreadId: "source",
        message: "alternate path",
        reasoning: "minimal",
      }),
    ).resolves.toEqual({ threadId: "fork", response: "forked" });

    const fork = await session.getOrCreateThread("fork");
    expect(emitUpdate).toHaveBeenCalledWith(
      "fork",
      expect.objectContaining({
        costTotal: 0,
        usage: expect.objectContaining({ contextWindowUsageTokens: 3 }),
      }),
    );
    expect(fork.runtime).toBeInstanceOf(AgentRuntime);
    expect(fork.runtime.agentIdValue).not.toBe(source.runtime.agentIdValue);
    expect(fork.runtime.rawHistory.slice(0, source.runtime.rawHistory.length)).toEqual(
      source.runtime.rawHistory,
    );
    expect(fork.runtime.spec.attribution.reasoningEffort).toBe("minimal");
    expect(source.runtime.spec.attribution.reasoningEffort).toBe("high");

    expect(recordUsage).toHaveBeenCalledTimes(3);
    for (const [entry] of recordUsage.mock.calls) {
      expect(entry.agent).toEqual({ type: "ephemeral" });
    }
    expect(recordUsage.mock.calls.map(([entry]) => entry.reasoningEffort)).toEqual([
      "high",
      "high",
      "minimal",
    ]);
  });

  it("rejects a partial provider failure", async () => {
    const { session } = createSession();
    const thread = await session.getOrCreateThread("source");
    const streamError = new Error("stream failed");
    thread.runtime.spec.retryPolicy = { maxRetries: 0, delayMs: 0 };
    thread.runtime.spec.model.stream = vi.fn(() =>
      createFailingStream("incomplete review", streamError),
    );

    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "source",
        message: "review this",
      }),
    ).rejects.toThrow("stream failed");
    expect(thread.runtime.rawHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "incomplete review" }],
      stopReason: "error",
      errorMessage: "stream failed",
    });
  });

  it("does not apply model system notices to ephemeral agents", async () => {
    const model = personas[0].model;
    const notice = "main and subagent notice";
    const { session } = createSession(vi.fn(), {
      modelSystemNotices: { [`${model.provider}/${model.id}`]: notice },
    });
    const thread = await session.getOrCreateThread("source");
    const stream = vi.fn(() => createStream(createAssistant("reviewed")));
    thread.runtime.spec.model.stream = stream;

    await session.submitThreadMessage({
      contextId: "ephemeral-1",
      threadId: "source",
      message: "review this",
    });

    expect(JSON.stringify(stream.mock.calls[0][0])).not.toContain(notice);
    expect(JSON.stringify(thread.runtime.rawHistory)).not.toContain(notice);
  });
});
