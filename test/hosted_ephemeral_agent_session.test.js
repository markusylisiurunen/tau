import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
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

function createSession(
  recordUsage = vi.fn(),
  config = { autoCompact: { enabled: false } },
  reasoning = "medium",
) {
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
        unknownSkills: [],
      },
    }),
  };
  const emitUpdate = vi.fn();
  return {
    emitUpdate,
    recordUsage,
    session: new HostedEphemeralAgentSession({
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
  it("continues and forks thread state", async () => {
    const { session, recordUsage, emitUpdate } = createSession(
      vi.fn(),
      { autoCompact: { enabled: false } },
      "low",
    );
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
      autoCompact: { enabled: false },
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
