import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/index.js";
import { resolveModel } from "../dist/core/models/catalog.js";
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

function createSession(recordUsage = vi.fn()) {
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
          nodeVersion: "v24.0.0",
          includeAgentContext,
        },
        agentsFiles: [],
        warnings: [],
        unknownSkills: [],
      },
    }),
  };
  return {
    recordUsage,
    session: new HostedEphemeralAgentSession({
      contextId: "ephemeral-1",
      persona: personas[0],
      config: { autoCompact: { enabled: false } },
      modelResolver: resolveModel,
      discoveredSkills: [],
      includeAgentContext: false,
      executionEnvironment,
      instructions: "review the diff",
      tools: [],
      emitUpdate: vi.fn(),
      recordUsage,
    }),
  };
}

describe("HostedEphemeralAgentSession", () => {
  it("uses AgentRuntime for continuation and cloned fork threads", async () => {
    const { session, recordUsage } = createSession();
    const source = await session.getOrCreateThread("source");
    expect(source.runtime).toBeInstanceOf(AgentRuntime);
    const sourceResponses = [createAssistant("first"), createAssistant("continued")];
    source.runtime.modelRuntime.streamModel = vi.fn(() => createStream(sourceResponses.shift()));

    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "source",
        message: "first request",
      }),
    ).resolves.toEqual({ threadId: "source", response: "first" });
    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "source",
        message: "continue",
      }),
    ).resolves.toEqual({ threadId: "source", response: "continued" });

    const fork = await session.getOrCreateThread("fork", "source");
    expect(fork.runtime).toBeInstanceOf(AgentRuntime);
    expect(fork.runtime.agentIdValue).not.toBe(source.runtime.agentIdValue);
    expect(fork.runtime.rawHistory).toEqual(source.runtime.rawHistory);
    fork.runtime.modelRuntime.streamModel = vi.fn(() => createStream(createAssistant("forked")));
    await expect(
      session.submitThreadMessage({
        contextId: "ephemeral-1",
        threadId: "fork",
        message: "alternate path",
      }),
    ).resolves.toEqual({ threadId: "fork", response: "forked" });

    expect(recordUsage).toHaveBeenCalledTimes(3);
    for (const [entry] of recordUsage.mock.calls) {
      expect(entry.agent).toEqual({ type: "ephemeral" });
    }
  });
});
