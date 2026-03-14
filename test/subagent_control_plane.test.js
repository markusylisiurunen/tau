import { describe, expect, it, vi } from "vitest";

const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(),
}));

vi.mock("../dist/core/subagents/subagent_engine.js", () => ({
  runSubagent: runSubagentMock,
}));

import { SubagentControlPlane } from "../dist/core/subagents/control_plane.js";

describe("subagent control plane origin correlation", () => {
  it("rejects blank subagent workingDirectory at spawn boundary", () => {
    const controlPlane = new SubagentControlPlane({
      onEvent: () => {},
    });

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

  it("preserves spawn origin history entry across send_input_to_agent runs", async () => {
    runSubagentMock.mockReset();
    runSubagentMock.mockResolvedValue({
      finalText: "done",
      costTotal: 0,
      turns: 1,
      toolCalls: 0,
    });

    const controlPlane = new SubagentControlPlane({
      onEvent: () => {},
    });

    const spawnResult = controlPlane.spawn({
      runtimeConfig: {
        name: "default",
        workingDirectory: "/repo",
      },
      prompt: "first",
      title: "research",
      originHistoryEntryId: "history-1",
      config: {},
      backend: {},
    });

    expect(spawnResult.ok).toBe(true);
    const id = spawnResult.id;

    await controlPlane.waitFor([id]);
    expect(controlPlane.getOriginHistoryEntryId(id)).toBe("history-1");

    const sendInputResult = controlPlane.sendInput({
      id,
      prompt: "follow-up",
      config: {},
      backend: {},
    });

    expect(sendInputResult.ok).toBe(true);

    await controlPlane.waitFor([id]);
    expect(controlPlane.getOriginHistoryEntryId(id)).toBe("history-1");
  });
});
