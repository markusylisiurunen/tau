import { describe, expect, it, vi } from "vitest";
import {
  AsyncSessionManagerError,
  createAsyncSessionManager,
  createScopedAsyncSessionManager,
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

  let eventListener;

  const client = {
    ready: { sessionId: "rpc-1" },
    submit,
    interrupt: vi.fn(async () => ({ interrupted: true, isTurnRunning: true })),
    snapshot: vi.fn(async () => ({ sessionId: "rpc-1", isTurnRunning: false, historyLength: 0 })),
    reset: vi.fn(async () => ({ previousSessionId: "rpc-1", sessionId: "rpc-2" })),
    shutdown: vi.fn(async () => ({ shutdown: true })),
    close: vi.fn(async () => {}),
    onEvent: vi.fn((listener) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) {
          eventListener = undefined;
        }
      };
    }),
  };

  return {
    client,
    submitDeferred,
    emitEvent: (event) => {
      eventListener?.(event);
    },
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
        return { workspacePath: "/tmp/ws/demo", sessionCwd: "/tmp/ws/demo" };
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

  it("starts sdk client from the prepared session cwd", async () => {
    const clientHarness = createClientHarness();
    const createClient = vi.fn(async () => clientHarness.client);

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo/packages/core",
      })),
      createClient,
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/ws/demo/packages/core",
      }),
    );
  });

  it("creates short session ids for public use", async () => {
    const clientHarness = createClientHarness();
    const prepareWorkspace = vi.fn(async ({ sessionId }) => ({
      workspacePath: `/tmp/ws/${sessionId}`,
      sessionCwd: `/tmp/ws/${sessionId}`,
    }));

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace,
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    expect(created.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
    expect(prepareWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: created.id,
      }),
    );
  });

  it("prepends configured system message to submitted user text", async () => {
    const clientHarness = createClientHarness();
    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      systemMessage: "follow project conventions",
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "write issue about X");
    expect(clientHarness.client.submit).toHaveBeenCalledWith(
      "<system>\nfollow project conventions\n</system>\nwrite issue about X",
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-system-msg",
      turn: { aborted: false },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("appends additional system message for per-submit context", async () => {
    const clientHarness = createClientHarness();
    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      systemMessage: "follow project conventions",
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "write issue about X", {
      additionalSystemMessage: "this message came from telegram",
    });
    expect(clientHarness.client.submit).toHaveBeenCalledWith(
      "<system>\nfollow project conventions\nthis message came from telegram\n</system>\nwrite issue about X",
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-system-msg-extra",
      turn: { aborted: false },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("applies additional system message to initial prompt submissions", async () => {
    const clientHarness = createClientHarness();
    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      systemMessage: "follow project conventions",
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({
      projectId: "demo",
      prompt: "check docs drift",
      additionalSystemMessage: "this prompt came from cron",
    });

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-system-msg-initial",
      turn: { aborted: false },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    expect(clientHarness.client.submit).toHaveBeenCalledWith(
      "<system>\nfollow project conventions\nthis prompt came from cron\n</system>\ncheck docs drift",
    );
  });

  it("returns from sendMessage immediately and rejects concurrent submits", async () => {
    const clientHarness = createClientHarness();
    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const accepted = await manager.sendMessage(created.id, "first");
    expect(accepted.state).toBe("running");
    expect(clientHarness.client.submit).toHaveBeenCalledTimes(1);

    await expect(manager.sendMessage(created.id, "second")).rejects.toEqual(
      expect.objectContaining({
        code: "busy",
      }),
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-1",
      turn: { aborted: false },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("marks the session failed and closes the client when submit rejects", async () => {
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const accepted = await manager.sendMessage(created.id, "first");
    expect(accepted.state).toBe("running");

    await waitFor(() => manager.getSession(created.id)?.state === "failed");

    const failed = manager.getSession(created.id);
    expect(failed).toEqual(
      expect.objectContaining({
        state: "failed",
        error: "submit boom",
      }),
    );

    await waitFor(() => clientHarness.client.close.mock.calls.length === 1);
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "submit failed")).toBe(true);
  });

  it("does not duplicate error logs when initial prompt submit fails", async () => {
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo", prompt: "hello" });
    await waitFor(() => manager.getSession(created.id)?.state === "failed");

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.filter((entry) => entry.message === "submit failed")).toHaveLength(1);
    expect(logs.filter((entry) => entry.message === "session failed")).toHaveLength(0);
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
  });

  it("interrupts a running session without closing it", async () => {
    const clientHarness = createClientHarness();
    clientHarness.client.interrupt = vi.fn(async () => {
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-interrupt",
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    const result = await manager.interruptSession(created.id);
    expect(result.interrupted).toBe(true);
    expect(result.session.id).toBe(created.id);

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(0);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(0);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "interrupt requested")).toBe(true);
  });

  it("returns a no-op interrupt result when no run is active", async () => {
    const clientHarness = createClientHarness();

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const result = await manager.interruptSession(created.id);
    expect(result).toEqual(
      expect.objectContaining({
        interrupted: false,
        isTurnRunning: false,
        session: expect.objectContaining({ id: created.id, state: "waiting-input" }),
      }),
    );

    expect(clientHarness.client.interrupt).not.toHaveBeenCalled();
  });

  it("closes terminal failed sessions", async () => {
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "first");
    await waitFor(() => manager.getSession(created.id)?.state === "failed");

    const closed = await manager.closeSession(created.id);
    expect(closed.state).toBe("failed");
    expect(manager.getSession(created.id)).toBeUndefined();
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
  });

  it("closes a running session and shuts down the sdk client", async () => {
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const runningSubmit = manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    const closed = await manager.closeSession(created.id);
    expect(closed.id).toBe(created.id);

    await runningSubmit;

    expect(manager.getSession(created.id)).toBeUndefined();
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to computed workspace path when closed during preparation", async () => {
    const workspaceDeferred = deferred();
    const clientHarness = createClientHarness();
    const cleanupWorkspacePath = vi.fn(async () => {});

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
          workspaceRoot: "/tmp/project-root",
        },
      },
      workspaceRoot: "/tmp/global-root",
      prepareWorkspace: vi.fn(async ({ sessionId, projectId, workspaceRoot }) => {
        await workspaceDeferred.promise;
        return {
          workspacePath: `${workspaceRoot}/${projectId}/${sessionId}`,
          sessionCwd: `${workspaceRoot}/${projectId}/${sessionId}`,
        };
      }),
      createClient: vi.fn(async () => clientHarness.client),
      cleanupWorkspacePath,
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "preparing-workspace");

    const closedPromise = manager.closeSession(created.id);
    workspaceDeferred.resolve();
    await closedPromise;

    await waitFor(() => cleanupWorkspacePath.mock.calls.length === 1);
    expect(cleanupWorkspacePath).toHaveBeenCalledWith(`/tmp/project-root/demo/${created.id}`);
    expect(manager.getSession(created.id)).toBeUndefined();
  });

  it("closes a selected session, removes it from memory, and deletes workspace", async () => {
    const clientHarness = createClientHarness();
    const cleanupWorkspacePath = vi.fn(async () => {});

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
      cleanupWorkspacePath,
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const closed = await manager.closeSession(created.id);
    expect(closed).toEqual(expect.objectContaining({ id: created.id, state: "waiting-input" }));
    expect(manager.getSession(created.id)).toBeUndefined();
    expect(manager.listSessions()).toEqual([]);
    expect(manager.getLogs(created.id)).toBeUndefined();
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspacePath).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspacePath).toHaveBeenCalledWith("/tmp/ws/demo");
  });

  it("does not close queued or preparing sessions in bulk", async () => {
    const workspaceDeferred = deferred();

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => {
        await workspaceDeferred.promise;
        return {
          workspacePath: "/tmp/ws/demo",
          sessionCwd: "/tmp/ws/demo",
        };
      }),
      createClient: vi.fn(async () => createClientHarness().client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    expect(["queued", "preparing-workspace"]).toContain(manager.getSession(created.id)?.state);

    const closed = await manager.closeInactiveSessions();
    expect(closed).toEqual([]);
    expect(manager.getSession(created.id)).toEqual(expect.objectContaining({ id: created.id }));
  });

  it("closes waiting-input and failed sessions in bulk", async () => {
    const waitingInputClientHarness = createClientHarness();
    const failedClientHarness = createClientHarness();
    const runningClientHarness = createClientHarness();
    const clients = [
      waitingInputClientHarness.client,
      failedClientHarness.client,
      runningClientHarness.client,
    ];

    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => {
        const next = clients.shift();
        if (!next) {
          throw new Error("missing client");
        }
        return next;
      }),
    });

    const waitingInput = await manager.createSession({ projectId: "demo" });
    const failed = await manager.createSession({ projectId: "demo" });
    const running = await manager.createSession({ projectId: "demo" });

    await waitFor(() => manager.getSession(waitingInput.id)?.state === "waiting-input");
    await waitFor(() => manager.getSession(failed.id)?.state === "waiting-input");
    await waitFor(() => manager.getSession(running.id)?.state === "waiting-input");

    await manager.sendMessage(failed.id, "fail");
    await waitFor(() => manager.getSession(failed.id)?.state === "running");
    failedClientHarness.submitDeferred.reject(new Error("submit boom"));
    await waitFor(() => manager.getSession(failed.id)?.state === "failed");

    await manager.sendMessage(running.id, "run");
    await waitFor(() => manager.getSession(running.id)?.state === "running");

    const closed = await manager.closeInactiveSessions();
    expect(closed).toEqual([
      expect.objectContaining({ id: waitingInput.id }),
      expect.objectContaining({ id: failed.id }),
    ]);
    expect(manager.getSession(waitingInput.id)).toBeUndefined();
    expect(manager.getSession(failed.id)).toBeUndefined();
    expect(manager.getSession(running.id)).toEqual(expect.objectContaining({ id: running.id }));

    runningClientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-running",
      turn: { aborted: false },
    });
    await waitFor(() => manager.getSession(running.id)?.state === "waiting-input");
    await manager.closeSession(running.id);
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const runningSubmit = manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    await manager.close();
    await runningSubmit;

    expect(manager.getSession(created.id)?.state).toBe("running");
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await expect(Promise.all([manager.close(), manager.close(), manager.close()])).resolves.toEqual(
      [undefined, undefined, undefined],
    );

    expect(manager.getSession(created.id)?.state).toBe("waiting-input");
    expect(clientHarness.client.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.shutdown).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "interrupt failed")).toBe(true);
    expect(logs.some((entry) => entry.message === "shutdown failed")).toBe(true);
    expect(logs.some((entry) => entry.message === "close failed")).toBe(true);
  });

  it("emits progress events for bash/edit/write and assistant output", async () => {
    const clientHarness = createClientHarness();
    const manager = createAsyncSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const events = [];
    manager.onEvent((event) => {
      events.push(event);
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const sendPromise = manager.sendMessage(created.id, "run tasks");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    clientHarness.emitEvent({
      version: 1,
      type: "event",
      event: {
        version: 1,
        event: {
          type: "tool_ui",
          uiEvent: {
            type: "bash_started",
            toolCallId: "1",
            command: "npm run check",
          },
        },
      },
    });

    clientHarness.emitEvent({
      version: 1,
      type: "event",
      event: {
        version: 1,
        event: {
          type: "tool_ui",
          uiEvent: {
            type: "edit_success",
            toolCallId: "2",
            path: "src/core/async/telegram.ts",
            oldLength: 1,
            newLength: 2,
            oldText: "a",
            newText: "b",
            uiText: { previewLines: [], fullLines: [] },
          },
        },
      },
    });

    clientHarness.emitEvent({
      version: 1,
      type: "event",
      event: {
        version: 1,
        event: {
          type: "tool_ui",
          uiEvent: {
            type: "write_success",
            toolCallId: "3",
            path: "docs/async.md",
            bytes: 10,
            lines: 1,
            content: "hello",
            uiText: { previewLines: [], fullLines: [] },
          },
        },
      },
    });

    clientHarness.emitEvent({
      version: 1,
      type: "event",
      event: {
        version: 1,
        event: {
          type: "assistant_final",
          historyEntryId: "h1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        },
      },
    });

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-progress",
      turn: { aborted: false },
    });
    await sendPromise;

    expect(
      events.some(
        (event) =>
          event.type === "session-progress" &&
          event.sessionId === created.id &&
          event.progress.type === "bash-command" &&
          event.progress.command === "npm run check",
      ),
    ).toBe(true);

    expect(
      events.some(
        (event) =>
          event.type === "session-progress" &&
          event.sessionId === created.id &&
          event.progress.type === "edited-file" &&
          event.progress.path === "src/core/async/telegram.ts",
      ),
    ).toBe(true);

    expect(
      events.some(
        (event) =>
          event.type === "session-progress" &&
          event.sessionId === created.id &&
          event.progress.type === "wrote-file" &&
          event.progress.path === "docs/async.md",
      ),
    ).toBe(true);

    expect(
      events.some(
        (event) =>
          event.type === "session-progress" &&
          event.sessionId === created.id &&
          event.progress.type === "assistant-message" &&
          event.progress.text === "done",
      ),
    ).toBe(true);
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
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
      })),
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

  it("filters session visibility and mutations by allowed projects and owner", async () => {
    const ownerId = "telegram:ops";
    const sessions = [
      {
        id: "s-demo-owned",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
      },
      {
        id: "s-demo-other-owner",
        projectId: "demo",
        ownerId: "telegram:docs",
        state: "waiting-input",
      },
      {
        id: "s-docs-owned",
        projectId: "docs",
        ownerId,
        state: "waiting-input",
      },
    ];

    const manager = {
      createSession: vi.fn(async ({ projectId, ownerId: createOwnerId }) => ({
        id: `created-${projectId}`,
        projectId,
        ownerId: createOwnerId,
        state: "queued",
      })),
      listSessions: vi.fn(() => sessions.map((session) => ({ ...session }))),
      getSession: vi.fn((sessionId) => {
        const session = sessions.find((entry) => entry.id === sessionId);
        return session ? { ...session } : undefined;
      }),
      getLogs: vi.fn(() => []),
      sendMessage: vi.fn(async (sessionId) => ({
        id: sessionId,
        projectId: "demo",
        ownerId,
        state: "running",
      })),
      interruptSession: vi.fn(async (sessionId) => ({
        session: { id: sessionId, projectId: "demo", ownerId, state: "waiting-input" },
        interrupted: true,
        isTurnRunning: false,
      })),
      closeSession: vi.fn(async (sessionId) => ({
        id: sessionId,
        projectId: "demo",
        ownerId,
        state: "waiting-input",
      })),
      closeInactiveSessions: vi.fn(async () => []),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(() => () => {}),
    };

    const scopedManager = createScopedAsyncSessionManager({
      sessionManager: manager,
      ownerId,
      allowedProjectIds: ["demo"],
    });

    expect(scopedManager.listSessions()).toEqual([
      { id: "s-demo-owned", projectId: "demo", ownerId, state: "waiting-input" },
    ]);
    expect(scopedManager.getSession("s-demo-other-owner")).toBeUndefined();
    expect(scopedManager.getSession("s-docs-owned")).toBeUndefined();

    await expect(scopedManager.sendMessage("s-demo-other-owner", "hello")).rejects.toEqual(
      expect.objectContaining({
        code: "not_found",
      }),
    );

    await scopedManager.sendMessage("s-demo-owned", "hello");
    expect(manager.sendMessage).toHaveBeenCalledWith("s-demo-owned", "hello", undefined);

    await scopedManager.createSession({ projectId: "demo" });
    expect(manager.createSession).toHaveBeenCalledWith({
      projectId: "demo",
      ownerId,
    });
  });

  it("closes only scoped inactive sessions for /close all behavior", async () => {
    const ownerId = "telegram:ops";
    const sessions = [
      {
        id: "s-demo-ready",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
      },
      {
        id: "s-demo-running",
        projectId: "demo",
        ownerId,
        state: "running",
      },
      {
        id: "s-demo-other-owner",
        projectId: "demo",
        ownerId: "telegram:docs",
        state: "waiting-input",
      },
      {
        id: "s-docs-ready",
        projectId: "docs",
        ownerId,
        state: "waiting-input",
      },
    ];

    const manager = {
      createSession: vi.fn(),
      listSessions: vi.fn(() => sessions.map((session) => ({ ...session }))),
      getSession: vi.fn((sessionId) => {
        const session = sessions.find((entry) => entry.id === sessionId);
        return session ? { ...session } : undefined;
      }),
      getLogs: vi.fn(),
      sendMessage: vi.fn(),
      interruptSession: vi.fn(),
      closeSession: vi.fn(async (sessionId) => ({
        id: sessionId,
        projectId: "demo",
        ownerId,
        state: "waiting-input",
      })),
      closeInactiveSessions: vi.fn(async () => []),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(() => () => {}),
    };

    const scopedManager = createScopedAsyncSessionManager({
      sessionManager: manager,
      ownerId,
      allowedProjectIds: ["demo"],
    });

    const closed = await scopedManager.closeInactiveSessions();
    expect(closed).toEqual([
      { id: "s-demo-ready", projectId: "demo", ownerId, state: "waiting-input" },
    ]);
    expect(manager.closeSession).toHaveBeenCalledTimes(1);
    expect(manager.closeSession).toHaveBeenCalledWith("s-demo-ready");
    expect(manager.closeInactiveSessions).not.toHaveBeenCalled();
  });
});
