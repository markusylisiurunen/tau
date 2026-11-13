import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runHeadlessCommand } from "../dist/core/modes/run.js";

function harness(turn = { status: "completed", stopReason: "stop" }) {
  const session = {
    id: "saved-session",
    submit: vi.fn(async () => ({ userHistoryEntryId: "user", turn, response: "final\nanswer" })),
    interrupt: vi.fn(async () => ({})),
    snapshot: vi.fn(async () => ({
      messages: [
        {
          id: "old",
          state: "committed",
          message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        },
        { id: "user", state: "committed", message: { role: "user", content: "task" } },
        {
          id: "answer",
          state: "committed",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private" },
              { type: "text", text: "final\nanswer" },
            ],
          },
        },
      ],
    })),
  };
  const client = {
    sessions: { create: vi.fn(async () => session), observe: vi.fn(async () => session) },
    close: vi.fn(async () => {}),
  };
  const options = {
    stdin: Readable.from(["task\n"]),
    stdout: vi.fn(),
    stderr: vi.fn(),
    createClient: vi.fn(async () => client),
    cwd: "/repo",
  };
  return { session, client, options };
}

describe("headless run", () => {
  it("creates one normal session, reports its ID before submitting, and writes only the final text", async () => {
    const { session, client, options } = harness();
    session.submit.mockImplementation(async () => {
      expect(options.stderr).toHaveBeenCalledWith(expect.stringContaining(session.id));
      expect(options.stdout).not.toHaveBeenCalled();
      return {
        userHistoryEntryId: "user",
        turn: { status: "completed", stopReason: "stop" },
        response: "final\nanswer",
      };
    });
    expect(await runHeadlessCommand(["--persona", "example:high"], options)).toBe(0);
    expect(client.sessions.create).toHaveBeenCalledWith({
      executionEnvironment: { kind: "local", cwd: "/repo" },
      attributes: { source: "cli" },
      personaId: "example",
      reasoning: "high",
    });
    expect(session.submit).toHaveBeenCalledWith("task\n");
    expect(options.stdout).toHaveBeenCalledExactlyOnceWith("final\nanswer");
    expect(client.close.mock.invocationCallOrder[0]).toBeLessThan(
      options.stdout.mock.invocationCallOrder[0],
    );
  });

  it.each([
    { status: "completed", stopReason: "stop" },
    { status: "failed", stopReason: "error", errorMessage: "provider failed" },
    { status: "aborted", stopReason: "aborted" },
    { status: "blocked", reason: "auto-compaction-failed", message: "blocked" },
  ])("continues without creating a session and preserves outcome $status", async (turn) => {
    const { client, options } = harness(turn);
    expect(await runHeadlessCommand(["--session", "saved-session", "--json"], options)).toBe(
      turn.status === "completed" ? 0 : 1,
    );
    expect(client.sessions.create).not.toHaveBeenCalled();
    expect(client.sessions.observe).toHaveBeenCalledExactlyOnceWith("saved-session");
    expect(JSON.parse(options.stdout.mock.calls[0][0])).toEqual({
      sessionId: "saved-session",
      turn,
      response: "final\nanswer",
    });
  });

  it("interrupts active work and closes the host before returning", async () => {
    const { session, client, options } = harness();
    const controller = new AbortController();
    let finish;
    session.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          controller.abort();
        }),
    );
    session.interrupt.mockImplementation(async () =>
      finish({
        userHistoryEntryId: "user",
        turn: { status: "aborted", stopReason: "aborted" },
        response: "",
      }),
    );
    expect(await runHeadlessCommand([], { ...options, signal: controller.signal })).toBe(1);
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not emit a successful result when history settlement fails", async () => {
    const { client, options } = harness();
    client.close.mockRejectedValue(new Error("local history recording is incomplete"));
    await expect(runHeadlessCommand(["--json"], options)).rejects.toThrow();
    expect(options.stdout).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not invent a turn result when interrupted before submission", async () => {
    const { session, client, options } = harness();
    const controller = new AbortController();
    client.sessions.create.mockImplementation(async () => {
      controller.abort();
      return session;
    });
    await expect(
      runHeadlessCommand(["--json"], { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(session.submit).not.toHaveBeenCalled();
    expect(options.stdout).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an old response when a turn fails without assistant text", async () => {
    const { session, options } = harness({ status: "failed", stopReason: "error" });
    session.submit.mockResolvedValue({
      userHistoryEntryId: "user",
      turn: { status: "failed", stopReason: "error" },
      response: "",
    });
    expect(await runHeadlessCommand([], options)).toBe(1);
    expect(options.stdout).toHaveBeenCalledExactlyOnceWith("");
  });

  it("returns the turn response after compaction removes the submitted message", async () => {
    const { session, options } = harness();
    session.snapshot.mockResolvedValue({ messages: [] });
    expect(await runHeadlessCommand([], options)).toBe(0);
    expect(options.stdout).toHaveBeenCalledExactlyOnceWith("final\nanswer");
    expect(session.snapshot).not.toHaveBeenCalled();
  });

  it("rejects empty input and conflicting continuation options before creating a client", async () => {
    const { options } = harness();
    await expect(
      runHeadlessCommand([], { ...options, stdin: Readable.from([" \n"]) }),
    ).rejects.toThrow();
    await expect(
      runHeadlessCommand(["--session", "id", "--persona", "other"], options),
    ).rejects.toThrow();
    expect(options.createClient).not.toHaveBeenCalled();
  });
});
