import { describe, expect, it, vi } from "vitest";

const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(),
}));

vi.mock("../dist/core/subagents/subagent_engine.js", () => ({
  runSubagent: runSubagentMock,
}));

import { SubagentControlPlane } from "../dist/core/subagents/control_plane.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createControlPlane() {
  return new SubagentControlPlane({
    onEvent: () => {},
  });
}

function spawnAgent(controlPlane, title) {
  const spawnResult = controlPlane.spawn({
    runtimeConfig: {
      name: "default",
      workingDirectory: "/repo",
    },
    prompt: title,
    title,
    originHistoryEntryId: `history-${title}`,
    config: {},
    backend: {},
  });

  expect(spawnResult.ok).toBe(true);
  return spawnResult.id;
}

describe("subagent control plane origin correlation", () => {
  it("rejects blank subagent workingDirectory at spawn boundary", () => {
    const controlPlane = createControlPlane();

    const spawnResult = controlPlane.spawn({
      runtimeConfig: {
        name: "default",
        workingDirectory: "   ",
      },
      prompt: "first",
      title: "research",
      originHistoryEntryId: "history-1",
      config: {},
      backend: {},
    });

    expect(spawnResult).toEqual({
      ok: false,
      reason: "Subagent workingDirectory must not be blank.",
    });
  });

  it("aborts and removes agents whose origin is no longer retained", () => {
    runSubagentMock.mockReset();
    const signals = [];
    runSubagentMock.mockImplementation(({ signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });

    const controlPlane = createControlPlane();
    const retainedId = spawnAgent(controlPlane, "retained");
    const removedId = spawnAgent(controlPlane, "removed");

    controlPlane.retainOrigins(new Set(["history-retained"]));

    expect(controlPlane.getSnapshot(retainedId)).toEqual(
      expect.objectContaining({ id: retainedId, status: "running" }),
    );
    expect(controlPlane.getSnapshot(removedId)).toBeUndefined();
    expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
  });

  it("rebases removed origins without interrupting agents", () => {
    runSubagentMock.mockReset();
    const signals = [];
    runSubagentMock.mockImplementation(({ signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });

    const controlPlane = createControlPlane();
    const retainedId = spawnAgent(controlPlane, "retained");
    const rebasedId = spawnAgent(controlPlane, "rebased");

    controlPlane.rebaseMissingOrigins(new Set(["history-retained"]), "compaction-summary");

    expect(controlPlane.getOriginHistoryEntryId(retainedId)).toBe("history-retained");
    expect(controlPlane.getOriginHistoryEntryId(rebasedId)).toBe("compaction-summary");
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
  });

  it("preserves spawn origin history entry across send_input_to_agent runs", async () => {
    runSubagentMock.mockReset();
    runSubagentMock.mockResolvedValue({
      finalText: "done",
      costTotal: 0,
      turns: 1,
      toolCalls: 0,
    });

    const controlPlane = createControlPlane();
    const id = spawnAgent(controlPlane, "research");

    await controlPlane.waitForAgents([id]);
    expect(controlPlane.getOriginHistoryEntryId(id)).toBe("history-research");

    const sendInputResult = controlPlane.sendInput({
      id,
      prompt: "follow-up",
      config: {},
      backend: {},
    });

    expect(sendInputResult.ok).toBe(true);

    await controlPlane.waitForAgents([id]);
    expect(controlPlane.getOriginHistoryEntryId(id)).toBe("history-research");
  });
});

describe("subagent control plane waitForAgents", () => {
  it("returns when the first requested running agent completes", async () => {
    runSubagentMock.mockReset();
    const first = createDeferred();
    const second = createDeferred();
    runSubagentMock.mockImplementationOnce(() => first.promise);
    runSubagentMock.mockImplementationOnce(() => second.promise);

    const controlPlane = createControlPlane();
    const firstId = spawnAgent(controlPlane, "first");
    const secondId = spawnAgent(controlPlane, "second");

    let resolved = false;
    const waitPromise = controlPlane.waitForAgents([firstId, secondId]).then((results) => {
      resolved = true;
      return results;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    first.resolve({
      finalText: "first done",
      costTotal: 1,
      turns: 1,
      toolCalls: 0,
    });

    const results = await waitPromise;
    expect(results.map((result) => result.id)).toEqual([firstId]);
    expect(results[0].finalText).toBe("first done");

    second.resolve({
      finalText: "second done",
      costTotal: 1,
      turns: 1,
      toolCalls: 0,
    });
    await controlPlane.waitForAgents([secondId]);
  });

  it("returns already completed requested agents immediately", async () => {
    runSubagentMock.mockReset();
    const second = createDeferred();
    runSubagentMock.mockResolvedValueOnce({
      finalText: "first done",
      costTotal: 1,
      turns: 1,
      toolCalls: 0,
    });
    runSubagentMock.mockImplementationOnce(() => second.promise);

    const controlPlane = createControlPlane();
    const firstId = spawnAgent(controlPlane, "first");
    const secondId = spawnAgent(controlPlane, "second");

    await controlPlane.waitForAgents([firstId]);

    const results = await controlPlane.waitForAgents([firstId, secondId]);
    expect(results.map((result) => result.id)).toEqual([firstId]);

    second.resolve({
      finalText: "second done",
      costTotal: 1,
      turns: 1,
      toolCalls: 0,
    });
    await controlPlane.waitForAgents([secondId]);
  });

  it("returns completed agents in requested order", async () => {
    runSubagentMock.mockReset();
    runSubagentMock.mockResolvedValue({
      finalText: "done",
      costTotal: 1,
      turns: 1,
      toolCalls: 0,
    });

    const controlPlane = createControlPlane();
    const firstId = spawnAgent(controlPlane, "first");
    const secondId = spawnAgent(controlPlane, "second");

    await controlPlane.waitForAgents([firstId]);
    await controlPlane.waitForAgents([secondId]);

    const results = await controlPlane.waitForAgents([secondId, firstId]);
    expect(results.map((result) => result.id)).toEqual([secondId, firstId]);
  });
});
