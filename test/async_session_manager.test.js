import { describe, expect, it, vi } from "vitest";
import {
  AsyncSessionManagerError,
  createAsyncSessionManager,
} from "../dist/core/async/session_manager.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createClientHarness() {
  const submitDeferred = deferred();
  const submit = vi.fn(async () => {
    return await submitDeferred.promise;
  });

  const client = {
    ready: { sessionId: "rpc-1" },
    submit,
    interrupt: vi.fn(async () => ({ interrupted: true, isTurnRunning: true })),
    snapshot: vi.fn(async () => ({ sessionId: "rpc-1", isTurnRunning: false, historyLength: 0 })),
    reset: vi.fn(async () => ({ previousSessionId: "rpc-1", sessionId: "rpc-2" })),
    shutdown: vi.fn(async () => ({ shutdown: true })),
    close: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
  };

  return {
    client,
    submitDeferred,
  };
}

describe("async session manager", () => {
  it("creates a session and transitions to waiting-input after workspace/client setup", async () => {
    const workspaceDeferred = deferred();
    const clientHarness = createClientHarness();

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => {
        await workspaceDeferred.promise;
        return { workspacePath: "/tmp/ws/demo" };
      }),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    expect(["queued", "preparing-workspace"]).toContain(created.state);

    workspaceDeferred.resolve();

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
    const current = manager.getSession(created.id);
    expect(current).toEqual(
      expect.objectContaining({
        state: "waiting-input",
        workspacePath: "/tmp/ws/demo",
        rpcSessionId: "rpc-1",
      }),
    );
  });

  it("rejects sendMessage with busy when a submit is already running", async () => {
    const clientHarness = createClientHarness();
    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const sendPromise = manager.sendMessage(created.id, "first");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    await expect(manager.sendMessage(created.id, "second")).rejects.toEqual(
      expect.objectContaining({
        code: "busy",
      }),
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-1",
      turn: { aborted: false },
    });
    await sendPromise;

    expect(manager.getSession(created.id)?.state).toBe("waiting-input");
  });

  it("marks the session failed when sendMessage submit rejects", async () => {
    const clientHarness = createClientHarness();
    clientHarness.client.submit = vi.fn(async () => {
      throw new Error("submit boom");
    });

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await expect(manager.sendMessage(created.id, "first")).rejects.toThrow("submit boom");

    const failed = manager.getSession(created.id);
    expect(failed).toEqual(
      expect.objectContaining({
        state: "failed",
        error: "submit boom",
      }),
    );

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "submit failed")).toBe(true);
  });

  it("does not rewrite terminal failed sessions to canceled", async () => {
    const clientHarness = createClientHarness();
    clientHarness.client.submit = vi.fn(async () => {
      throw new Error("submit boom");
    });

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await expect(manager.sendMessage(created.id, "first")).rejects.toThrow("submit boom");

    const canceled = await manager.cancelSession(created.id);
    expect(canceled.state).toBe("failed");
    expect(clientHarness.client.interrupt).not.toHaveBeenCalled();
    expect(clientHarness.client.shutdown).not.toHaveBeenCalled();
    expect(clientHarness.client.close).not.toHaveBeenCalled();
  });

  it("cancels a running session and shuts down the sdk client", async () => {
    const clientHarness = createClientHarness();
    clientHarness.client.interrupt = vi.fn(async () => {
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-2",
        turn: { aborted: true },
      });
      return { interrupted: true, isTurnRunning: true };
    });

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const runningSubmit = manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    const canceled = await manager.cancelSession(created.id);
    expect(canceled.state).toBe("canceled");

    await runningSubmit;

    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);

    const logs = manager.getLogs(created.id);
    expect(logs.some((entry) => entry.message === "cancel requested")).toBe(true);
  });

  it("closes active sessions and sdk clients during manager shutdown", async () => {
    const clientHarness = createClientHarness();
    clientHarness.client.interrupt = vi.fn(async () => {
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-4",
        turn: { aborted: true },
      });
      return { interrupted: true, isTurnRunning: true };
    });

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const runningSubmit = manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    await manager.close();
    await runningSubmit;

    expect(manager.getSession(created.id)?.state).toBe("canceled");
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "manager shutdown requested")).toBe(true);
  });

  it("close is idempotent and tolerates client shutdown failures", async () => {
    const clientHarness = createClientHarness();
    clientHarness.client.interrupt = vi.fn(async () => {
      throw new Error("interrupt boom");
    });
    clientHarness.client.shutdown = vi.fn(async () => {
      throw new Error("shutdown boom");
    });
    clientHarness.client.close = vi.fn(async () => {
      throw new Error("close boom");
    });

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await expect(Promise.all([manager.close(), manager.close(), manager.close()])).resolves.toEqual(
      [undefined, undefined, undefined],
    );

    expect(manager.getSession(created.id)?.state).toBe("canceled");
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "interrupt failed")).toBe(true);
    expect(logs.some((entry) => entry.message === "shutdown failed")).toBe(true);
    expect(logs.some((entry) => entry.message === "close failed")).toBe(true);
  });

  it("emits lightweight lifecycle events", async () => {
    const clientHarness = createClientHarness();
    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-3",
      turn: { aborted: false },
    });

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/ws/demo" })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const events = [];
    const unsubscribe = manager.onEvent((event) => {
      events.push(event);
    });

    const created = await manager.createSession({ projectId: "demo", prompt: "hello" });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    unsubscribe();

    expect(events.some((event) => event.type === "session-created")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session-state-changed" &&
          event.sessionId === created.id &&
          event.state === "running",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session-log" &&
          event.sessionId === created.id &&
          event.log.message === "message finished",
      ),
    ).toBe(true);
  });

  it("throws invalid_project for unknown projects", async () => {
    const manager = createAsyncSessionManager({ projects: {} });

    await expect(manager.createSession({ projectId: "missing" })).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_project",
      }),
    );

    await expect(manager.sendMessage("missing", "hi")).rejects.toBeInstanceOf(
      AsyncSessionManagerError,
    );
  });
});
