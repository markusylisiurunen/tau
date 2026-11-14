import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runHeadlessCommand } from "../dist/core/modes/run.js";

function harness(turn = { status: "completed", stopReason: "stop" }, response = "final\nanswer") {
  const session = {
    id: "saved-session",
    submit: vi.fn(async () => ({ userHistoryEntryId: "user", turn, response })),
    interrupt: vi.fn(async () => ({})),
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
    const response = turn.status === "failed" ? "" : "final\nanswer";
    const { client, options } = harness(turn, response);
    expect(await runHeadlessCommand(["--session", "saved-session", "--json"], options)).toBe(
      turn.status === "completed" ? 0 : 1,
    );
    expect(client.sessions.create).not.toHaveBeenCalled();
    expect(client.sessions.observe).toHaveBeenCalledExactlyOnceWith("saved-session");
    expect(JSON.parse(options.stdout.mock.calls[0][0])).toEqual({
      sessionId: "saved-session",
      turn,
      response,
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

  it.each([{ args: [] }, { args: ["--json"] }])(
    "preserves the completed response on shutdown failure ($args)",
    async ({ args }) => {
      const { client, options } = harness();
      const cause = new Error("disk failure");
      client.close.mockRejectedValue(new AggregateError([cause], "shutdown failed"));
      expect(await runHeadlessCommand(args, options)).toBe(1);
      const output = options.stdout.mock.calls[0][0];
      if (args.includes("--json")) {
        expect(JSON.parse(output)).toEqual({
          sessionId: "saved-session",
          turn: { status: "completed", stopReason: "stop" },
          response: "final\nanswer",
        });
      } else {
        expect(output).toBe("final\nanswer");
      }
      expect(options.stderr.mock.calls.flat().join("")).toContain(cause.message);
      expect(client.close).toHaveBeenCalledTimes(1);
    },
  );

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
