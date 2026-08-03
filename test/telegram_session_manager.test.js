import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createScopedTelegramSessionManager,
  createTelegramSessionManager,
  TelegramSessionManagerError,
} from "../dist/core/telegram/session_manager.js";
import { SESSION_PROTOCOL_VERSION } from "../dist/protocol/session_protocol.js";
import { TauSessionProtocolResponseError } from "../dist/transport/errors.js";
import { createProtocolSnapshot } from "./helpers/session_protocol_fixtures.js";

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

  const session = {
    id: "rpc-1",
    submit: submit,
    steer: vi.fn(async () => {
      return await submitDeferred.promise;
    }),
    interrupt: vi.fn(async () => ({ interrupted: true, isTurnRunning: true })),
    setReasoning: vi.fn(async (reasoning) => ({
      revision: 2,
      settings: { personaId: "default", reasoning },
    })),
    exec: vi.fn(async () => ({
      output: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    })),
    snapshot: vi.fn(async () =>
      createProtocolSnapshot({
        sessionId: "rpc-1",
        revision: 1,
        executionEnvironment: { kind: "local", cwd: "/tmp/ws/demo", home: "/home/user" },
      }),
    ),
    unobserve: vi.fn(async () => ({ unobserved: true })),
    onDelta: vi.fn((listener) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) {
          eventListener = undefined;
        }
      };
    }),
  };

  const client = {
    ready: {
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      methods: [],
    },
    sessions: {
      create: vi.fn(async () => session),
      observe: vi.fn(async () => session),
      list: vi.fn(async () => [{ sessionId: "rpc-1", lifecycle: "idle" }]),
    },
    close: vi.fn(async () => {}),
  };

  return {
    client,
    session,
    submitDeferred,
    emitDelta: (delta) => {
      eventListener?.(delta);
    },
  };
}

function createPatchDelta(changes, revision = 1, reason = "tool-run") {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.delta",
    sessionId: "rpc-1",
    fromRevision: revision,
    toRevision: revision + 1,
    reason,
    delta: { type: "snapshot.patch", changes },
  };
}

function createToolUiFacetChange(toolCallId, eventOrEvents) {
  const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
  return {
    type: "facet.set",
    facet: {
      id: `tool-ui-${toolCallId}`,
      subject: { type: "tool", id: toolCallId },
      kind: "tau.tool-ui-events",
      version: 1,
      data: { events },
    },
  };
}

function createAssistantProtocolMessage(id, content, stopReason = "stop") {
  return {
    id,
    state: "committed",
    modelVisible: true,
    message: {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      content,
      timestamp: 0,
    },
  };
}

function createDemoSessionManager(clientHarness) {
  return createTelegramSessionManager({
    projects: {
      demo: {
        repo: "git@example.com:demo.git",
      },
    },
    prepareWorkspace: vi.fn(async () => ({
      workspacePath: "/tmp/ws/demo",
      sessionCwd: "/tmp/ws/demo",
      provisionTargets: [],
    })),
    createClient: vi.fn(async () => clientHarness.client),
  });
}

async function startRunningSession(manager) {
  const created = await manager.createSession({ projectId: "demo" });
  await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

  const sendPromise = manager.sendMessage(created.id, "run tasks");
  await waitFor(() => manager.getSession(created.id)?.state === "running");

  return { created, sendPromise };
}

function assistantProgressTexts(events) {
  return events
    .filter(
      (event) => event.type === "session-progress" && event.progress.type === "assistant-message",
    )
    .map((event) => event.progress.text);
}

describe("telegram session manager", () => {
  it("creates a session and transitions to waiting-input after workspace/client setup", async () => {
    const workspaceDeferred = deferred();
    const clientHarness = createClientHarness();

    const manager = createTelegramSessionManager({
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
          provisionTargets: [],
        };
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
        tauSessionId: "rpc-1",
      }),
    );
  });

  it("starts sdk client from the prepared session cwd", async () => {
    const clientHarness = createClientHarness();
    const createClient = vi.fn(async () => clientHarness.client);

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo/packages/core",
        provisionTargets: [],
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

  it("starts repository provisioning without blocking readiness", async () => {
    const clientHarness = createClientHarness();
    const provisionDeferred = deferred();
    clientHarness.session.exec.mockImplementation(async () => {
      await provisionDeferred.promise;
      return { output: "", stdout: "", stderr: "", exitCode: 0, truncated: false };
    });

    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo/packages/core",
        provisionTargets: [
          {
            projectId: "demo",
            repositoryRoot: "/tmp/ws/demo",
            cwd: "/tmp/ws/demo/packages/core",
          },
        ],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
    await waitFor(() => clientHarness.session.exec.mock.calls.length === 1);

    expect(clientHarness.session.exec).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/ws/demo/.tau/scripts/provision"),
      { cwd: "/tmp/ws/demo/packages/core" },
    );
    const provisionCommand = clientHarness.session.exec.mock.calls[0][0];
    expect(provisionCommand).toContain('dd if="$provision_path" bs=2 count=1');
    expect(provisionCommand).toContain(".tau/scripts/provision must start with a shebang");

    provisionDeferred.resolve();
    await manager.closeSession(created.id);
  });

  it("restarts provisioning when a turn interrupt cancels its exec", async () => {
    const clientHarness = createClientHarness();
    const firstProvision = deferred();
    clientHarness.session.exec
      .mockImplementationOnce(async () => await firstProvision.promise)
      .mockResolvedValue({
        output: "",
        stdout: "",
        stderr: "",
        exitCode: 0,
        truncated: false,
      });
    clientHarness.session.interrupt = vi.fn(async () => {
      firstProvision.reject(
        new TauSessionProtocolResponseError({
          requestId: "provision-1",
          error: { code: "cancelled", message: "execution command was cancelled" },
        }),
      );
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-interrupt",
        turn: { status: "aborted", stopReason: "aborted" },
      });
      return { interrupted: true, isTurnRunning: true };
    });

    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [
          {
            projectId: "demo",
            repositoryRoot: "/tmp/ws/demo",
            cwd: "/tmp/ws/demo",
          },
        ],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => clientHarness.session.exec.mock.calls.length === 1);
    await manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    await manager.interruptSession(created.id);
    await waitFor(() => clientHarness.session.exec.mock.calls.length === 2);

    expect(manager.getProvisionFailures(created.id)).toEqual([]);
    expect(manager.getLogs(created.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "workspace provision restarting after session interrupt",
        }),
      ]),
    );
    await manager.closeSession(created.id);
  });

  it("provisions each composite repository from its configured working directory", async () => {
    const clientHarness = createClientHarness();
    const manager = createTelegramSessionManager({
      projects: {
        alpha: { repo: "owner/alpha" },
        beta: { repo: "owner/beta" },
        platform: {
          projectIds: ["alpha", "beta"],
          persona: "gpt-5.6-sol-coder:high",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/platform",
        sessionCwd: "/tmp/ws/platform",
        provisionTargets: [
          {
            projectId: "alpha",
            repositoryRoot: "/tmp/ws/platform/alpha",
            cwd: "/tmp/ws/platform/alpha",
          },
          {
            projectId: "beta",
            repositoryRoot: "/tmp/ws/platform/beta",
            cwd: "/tmp/ws/platform/beta/packages/core",
          },
        ],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "platform" });
    await waitFor(() => clientHarness.session.exec.mock.calls.length === 2);

    expect(clientHarness.session.exec.mock.calls).toEqual([
      [
        expect.stringContaining("/tmp/ws/platform/alpha/.tau/scripts/provision"),
        { cwd: "/tmp/ws/platform/alpha" },
      ],
      [
        expect.stringContaining("/tmp/ws/platform/beta/.tau/scripts/provision"),
        { cwd: "/tmp/ws/platform/beta/packages/core" },
      ],
    ]);
    await manager.closeSession(created.id);
  });

  it("reports provision failures while keeping the session usable", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.exec.mockResolvedValue({
      output: "dependencies failed",
      stdout: "",
      stderr: "dependencies failed",
      exitCode: 17,
      truncated: false,
    });
    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [
          {
            projectId: "demo",
            repositoryRoot: "/tmp/ws/demo",
            cwd: "/tmp/ws/demo",
          },
        ],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });
    const events = [];
    manager.onEvent((event) => events.push(event));

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => events.some((event) => event.type === "session-provision-failed"));

    const failure = {
      type: "session-provision-failed",
      sessionId: created.id,
      projectId: "demo",
      targetProjectId: "demo",
      diagnostic: "provision exited with code 17\ndependencies failed",
    };
    expect(events).toContainEqual(failure);
    expect(manager.getProvisionFailures(created.id)).toEqual([failure]);
    expect(manager.getSession(created.id)?.state).toBe("waiting-input");
    await manager.closeSession(created.id);
  });

  it("creates short session ids for public use", async () => {
    const clientHarness = createClientHarness();
    const prepareWorkspace = vi.fn(async ({ sessionId }) => ({
      workspacePath: `/tmp/ws/${sessionId}`,
      sessionCwd: `/tmp/ws/${sessionId}`,
      provisionTargets: [],
    }));

    const manager = createTelegramSessionManager({
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
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      systemMessage: "follow project conventions",
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "write issue about X");
    expect(clientHarness.session.submit).toHaveBeenCalledWith(
      "<system>follow project conventions</system>\nwrite issue about X",
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-system-msg",
      turn: { status: "completed", stopReason: "stop" },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("appends additional system message for per-submit context", async () => {
    const clientHarness = createClientHarness();
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      systemMessage: "follow project conventions",
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "write issue about X", {
      additionalSystemMessage: "this message came from telegram",
    });
    expect(clientHarness.session.submit).toHaveBeenCalledWith(
      "<system>follow project conventions\nthis message came from telegram</system>\nwrite issue about X",
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-system-msg-extra",
      turn: { status: "completed", stopReason: "stop" },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("allows explicit steering submissions while a session is running", async () => {
    const clientHarness = createClientHarness();
    const firstSubmit = deferred();
    const steeringSubmit = deferred();
    const submitDeferreds = [firstSubmit, steeringSubmit];
    clientHarness.session.submit = vi.fn(async () => await submitDeferreds.shift().promise);
    clientHarness.session.steer = vi.fn(async () => await submitDeferreds.shift().promise);
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "start work");
    await manager.sendMessage(created.id, "steer it", { mode: "steer" });

    expect(clientHarness.session.submit).toHaveBeenCalledWith("start work");
    expect(clientHarness.session.steer).toHaveBeenCalledWith("steer it");
    expect(manager.getSession(created.id)?.state).toBe("running");

    firstSubmit.resolve({
      userHistoryEntryId: "history-1",
      turn: { status: "completed", stopReason: "stop" },
    });
    await Promise.resolve();
    expect(manager.getSession(created.id)?.state).toBe("running");

    steeringSubmit.resolve({
      userHistoryEntryId: "history-2",
      turn: { status: "completed", stopReason: "stop" },
    });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("emits one failure event for a batched steering turn", async () => {
    const clientHarness = createClientHarness();
    const steeringTurn = deferred();
    clientHarness.session.steer = vi.fn(async () => await steeringTurn.promise);
    const manager = createDemoSessionManager(clientHarness);
    const events = [];
    manager.onEvent((event) => events.push(event));

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "first steering message", { mode: "steer" });
    await manager.sendMessage(created.id, "second steering message", { mode: "steer" });
    expect(clientHarness.session.steer).toHaveBeenCalledTimes(2);

    steeringTurn.resolve({
      userHistoryEntryId: "history-steering-batch",
      turn: {
        status: "failed",
        stopReason: "error",
        errorMessage: "OpenAI is unavailable",
      },
    });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    expect(events.filter((event) => event.type === "session-turn-failed")).toEqual([
      expect.objectContaining({
        sessionId: created.id,
        failure: expect.objectContaining({
          status: "failed",
          errorMessage: "OpenAI is unavailable",
        }),
      }),
    ]);
    expect(manager.getSession(created.id)?.error).toBeUndefined();
    expect(clientHarness.client.close).not.toHaveBeenCalled();

    clientHarness.session.submit.mockResolvedValueOnce({
      userHistoryEntryId: "history-next",
      turn: { status: "completed", stopReason: "stop" },
    });
    await manager.sendMessage(created.id, "try again");
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("returns from sendMessage immediately and rejects concurrent submits", async () => {
    const clientHarness = createClientHarness();
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const accepted = await manager.sendMessage(created.id, "first");
    expect(accepted.state).toBe("running");
    expect(clientHarness.session.submit).toHaveBeenCalledTimes(1);

    await expect(manager.sendMessage(created.id, "second")).rejects.toEqual(
      expect.objectContaining({
        code: "busy",
      }),
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-1",
      turn: { status: "completed", stopReason: "stop" },
    });

    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("keeps a provider-failed turn recoverable and accepts the next message", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-telegram-turn-failure-"));
    const workspacePath = join(tempRoot, "workspaces", "demo", "session");
    const persistencePath = join(tempRoot, "sessions.json");
    await mkdir(workspacePath, { recursive: true });

    const clientHarness = createClientHarness();
    clientHarness.session.submit = vi
      .fn()
      .mockResolvedValueOnce({
        userHistoryEntryId: "history-failed",
        turn: {
          status: "failed",
          stopReason: "error",
          errorMessage: "OpenAI is unavailable",
        },
      })
      .mockResolvedValueOnce({
        userHistoryEntryId: "history-completed",
        turn: { status: "completed", stopReason: "stop" },
      });

    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      persistencePath,
      prepareWorkspace: vi.fn(async () => ({
        workspacePath,
        sessionCwd: workspacePath,
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });
    const events = [];
    manager.onEvent((event) => events.push(event));
    let recoveredManager;

    try {
      const created = await manager.createSession({ projectId: "demo" });
      await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

      await manager.sendMessage(created.id, "first");
      await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

      expect(manager.getSession(created.id)?.error).toBeUndefined();
      expect(clientHarness.client.close).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session-turn-failed",
          sessionId: created.id,
          failure: {
            status: "failed",
            stopReason: "error",
            errorMessage: "OpenAI is unavailable",
          },
        }),
      );

      await manager.sendMessage(created.id, "second");
      await waitFor(() => clientHarness.session.submit.mock.calls.length === 2);
      await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
      await manager.close();

      const storedState = JSON.parse(await readFile(persistencePath, "utf8"));
      expect(storedState.sessions).toEqual([
        expect.objectContaining({ id: created.id, tauSessionId: "rpc-1" }),
      ]);

      const recoveredClientHarness = createClientHarness();
      recoveredManager = createTelegramSessionManager({
        projects: { demo: { repo: "git@example.com:demo.git" } },
        persistencePath,
        prepareWorkspace: vi.fn(async () => ({
          workspacePath,
          sessionCwd: workspacePath,
          provisionTargets: [],
        })),
        createClient: vi.fn(async () => recoveredClientHarness.client),
      });
      await recoveredManager.initialize();

      expect(recoveredManager.getSession(created.id)?.state).toBe("waiting-input");
      expect(recoveredClientHarness.client.sessions.observe).toHaveBeenCalledWith("rpc-1");
    } finally {
      await recoveredManager?.close();
      await manager.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a blocked turn active and accepts the next message", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.submit = vi
      .fn()
      .mockResolvedValueOnce({
        userHistoryEntryId: "history-blocked",
        turn: {
          status: "blocked",
          reason: "auto-compaction-failed",
          message: "automatic compaction failed",
        },
      })
      .mockResolvedValueOnce({
        userHistoryEntryId: "history-completed",
        turn: { status: "completed", stopReason: "stop" },
      });
    const manager = createDemoSessionManager(clientHarness);
    const events = [];
    manager.onEvent((event) => events.push(event));

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await manager.sendMessage(created.id, "first");
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    expect(manager.getSession(created.id)?.error).toBeUndefined();
    expect(clientHarness.client.close).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session-turn-failed",
        sessionId: created.id,
        failure: {
          status: "blocked",
          reason: "auto-compaction-failed",
          message: "automatic compaction failed",
        },
      }),
    );

    await manager.sendMessage(created.id, "second");
    await waitFor(() => clientHarness.session.submit.mock.calls.length === 2);
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
  });

  it("marks the session failed and closes the client when submit rejects", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.submit = vi.fn(async () => {
      throw new Error("submit boom");
    });

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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
    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "submit failed")).toBe(true);
  });

  it("interrupts a running session without closing it", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.interrupt = vi.fn(async () => {
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-interrupt",
        turn: { status: "aborted", stopReason: "aborted" },
      });
      return { interrupted: true, isTurnRunning: true };
    });

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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

    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(0);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(0);

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "interrupt requested")).toBe(true);
  });

  it("changes reasoning effort while a session is running", async () => {
    const clientHarness = createClientHarness();
    const manager = createDemoSessionManager(clientHarness);
    const { created, sendPromise } = await startRunningSession(manager);

    await expect(manager.setReasoning(created.id, "high")).resolves.toEqual({
      revision: 2,
      settings: { personaId: "default", reasoning: "high" },
    });
    expect(clientHarness.session.setReasoning).toHaveBeenCalledWith("high");

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-reasoning",
      turn: { status: "completed", stopReason: "stop" },
    });
    await sendPromise;
    await manager.close();
  });

  it("returns a no-op interrupt result when no run is active", async () => {
    const clientHarness = createClientHarness();

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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

    expect(clientHarness.session.interrupt).not.toHaveBeenCalled();
  });

  it("closes terminal failed sessions", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.submit = vi.fn(async () => {
      throw new Error("submit boom");
    });

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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
    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
  });

  it("closes a running session and shuts down the sdk client", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.interrupt = vi.fn(async () => {
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-2",
        turn: { status: "aborted", stopReason: "aborted" },
      });
      return { interrupted: true, isTurnRunning: true };
    });

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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
    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to computed workspace path when closed during preparation", async () => {
    const workspaceDeferred = deferred();
    const clientHarness = createClientHarness();
    const cleanupWorkspacePath = vi.fn(async () => {});

    const manager = createTelegramSessionManager({
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
          provisionTargets: [],
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

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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
    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspacePath).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspacePath).toHaveBeenCalledWith("/tmp/ws/demo");
  });

  it("does not close queued or preparing sessions in bulk", async () => {
    const workspaceDeferred = deferred();

    const manager = createTelegramSessionManager({
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
          provisionTargets: [],
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

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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
      turn: { status: "completed", stopReason: "stop" },
    });
    await waitFor(() => manager.getSession(running.id)?.state === "waiting-input");
    await manager.closeSession(running.id);
  });

  it("detaches active sessions without deleting recoverable state during manager shutdown", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.interrupt = vi.fn(async () => {
      clientHarness.submitDeferred.resolve({
        userHistoryEntryId: "history-4",
        turn: { status: "aborted", stopReason: "aborted" },
      });
      return { interrupted: true, isTurnRunning: true };
    });
    const cleanupWorkspacePath = vi.fn(async () => {});

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
      cleanupWorkspacePath,
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    const runningSubmit = manager.sendMessage(created.id, "run");
    await waitFor(() => manager.getSession(created.id)?.state === "running");

    await manager.close();
    await runningSubmit;

    expect(manager.getSession(created.id)?.state).toBe("waiting-input");
    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspacePath).not.toHaveBeenCalled();
  });

  it("removes a session when its initial persistence fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-telegram-session-persist-failure-"));
    const blockingPath = join(tempRoot, "not-a-directory");
    const prepareWorkspace = vi.fn();
    await writeFile(blockingPath, "value");

    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      persistencePath: join(blockingPath, "sessions.json"),
      prepareWorkspace,
      createClient: vi.fn(async () => createClientHarness().client),
    });

    try {
      await expect(manager.createSession({ projectId: "demo" })).rejects.toThrow();
      expect(manager.listSessions()).toEqual([]);
      expect(prepareWorkspace).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not persist failed sessions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-telegram-session-failure-"));
    const persistencePath = join(tempRoot, "sessions.json");
    const clientHarness = createClientHarness();
    clientHarness.session.submit = vi.fn(async () => {
      throw new Error("submit boom");
    });
    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      persistencePath,
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: join(tempRoot, "workspaces", "demo"),
        sessionCwd: join(tempRoot, "workspaces", "demo"),
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    try {
      const created = await manager.createSession({ projectId: "demo" });
      await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
      await manager.sendMessage(created.id, "fail");
      await waitFor(() => manager.getSession(created.id)?.state === "failed");
      await manager.close();

      const state = JSON.parse(await readFile(persistencePath, "utf8"));
      expect(state.sessions).toEqual([]);
    } finally {
      await manager.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("restores persisted sessions and reconnects their Tau snapshots", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-telegram-session-state-"));
    const workspacePath = join(tempRoot, "workspaces", "demo", "session");
    const persistencePath = join(tempRoot, "sessions.json");
    await mkdir(workspacePath, { recursive: true });

    const firstClientHarness = createClientHarness();
    const firstManager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      persistencePath,
      prepareWorkspace: vi.fn(async () => ({
        workspacePath,
        sessionCwd: workspacePath,
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => firstClientHarness.client),
    });

    try {
      const created = await firstManager.createSession({
        projectId: "demo",
        ownerId: "telegram:bot:chat:42",
      });
      await waitFor(() => firstManager.getSession(created.id)?.state === "waiting-input");
      await firstManager.close();

      const storedState = JSON.parse(await readFile(persistencePath, "utf8"));
      expect(storedState.sessions).toEqual([
        {
          id: created.id,
          projectId: "demo",
          ownerId: "telegram:bot:chat:42",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          tauSessionId: "rpc-1",
        },
      ]);
      await rm(workspacePath, { recursive: true, force: true });

      const recoveredClientHarness = createClientHarness();
      const prepareWorkspace = vi.fn(async () => {
        await mkdir(workspacePath, { recursive: true });
        return {
          workspacePath,
          sessionCwd: workspacePath,
          provisionTargets: [
            { projectId: "demo", repositoryRoot: workspacePath, cwd: workspacePath },
          ],
        };
      });
      const recoveredManager = createTelegramSessionManager({
        projects: { demo: { repo: "git@example.com:demo.git" } },
        persistencePath,
        prepareWorkspace,
        createClient: vi.fn(async () => recoveredClientHarness.client),
      });

      await recoveredManager.initialize();

      expect(recoveredManager.getSession(created.id)).toEqual(
        expect.objectContaining({
          state: "waiting-input",
          workspacePath,
          tauSessionId: "rpc-1",
          updatedAt: storedState.sessions[0].updatedAt,
        }),
      );
      expect(recoveredClientHarness.client.sessions.observe).toHaveBeenCalledWith("rpc-1");
      await waitFor(() => recoveredClientHarness.session.exec.mock.calls.length === 1);
      expect(prepareWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: created.id, projectId: "demo" }),
      );
      await expect(recoveredManager.getSessionSnapshot(created.id)).resolves.toEqual(
        expect.objectContaining({ sessionId: "rpc-1" }),
      );
      await recoveredManager.close();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reconnects persisted sessions concurrently", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-telegram-session-concurrency-"));
    const workspaceRoot = join(tempRoot, "workspaces");
    const persistencePath = join(tempRoot, "sessions.json");
    const sessionIds = ["first", "second"];
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        await mkdir(join(workspaceRoot, "demo", sessionId), { recursive: true });
      }),
    );
    await writeFile(
      persistencePath,
      `${JSON.stringify({
        version: 1,
        sessions: sessionIds.map((id) => ({
          id,
          projectId: "demo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          tauSessionId: `rpc-${id}`,
        })),
      })}\n`,
      "utf8",
    );

    const observeDeferred = deferred();
    const clientHarness = createClientHarness();
    clientHarness.client.sessions.observe = vi.fn(async () => {
      await observeDeferred.promise;
      return clientHarness.session;
    });
    const manager = createTelegramSessionManager({
      projects: { demo: { repo: "git@example.com:demo.git" } },
      workspaceRoot,
      persistencePath,
      createClient: vi.fn(async () => clientHarness.client),
    });

    try {
      const initialize = manager.initialize();
      await waitFor(() => clientHarness.client.sessions.observe.mock.calls.length === 2);
      observeDeferred.resolve();
      await initialize;

      expect(clientHarness.client.sessions.observe).toHaveBeenCalledTimes(2);
    } finally {
      observeDeferred.resolve();
      await manager.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("prunes orphaned workspaces while preserving recoverable workspaces", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-telegram-session-cleanup-"));
    const workspaceRoot = join(tempRoot, "workspaces");
    const projectWorkspaceRoot = join(tempRoot, "project-workspaces");
    const activeWorkspace = join(projectWorkspaceRoot, "demo", "active");
    const persistencePath = join(tempRoot, "sessions.json");
    await mkdir(activeWorkspace, { recursive: true });
    await writeFile(join(activeWorkspace, "keep.txt"), "keep");
    await mkdir(join(projectWorkspaceRoot, "demo", "orphan"), { recursive: true });
    await mkdir(join(workspaceRoot, "stale"), { recursive: true });
    await writeFile(
      persistencePath,
      `${JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "active",
            projectId: "demo",
            ownerId: "telegram:bot:chat:42",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            tauSessionId: "rpc-1",
          },
        ],
      })}\n`,
      "utf8",
    );

    const clientHarness = createClientHarness();
    const prepareWorkspace = vi.fn();
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
          workspaceRoot: projectWorkspaceRoot,
        },
      },
      workspaceRoot,
      persistencePath,
      prepareWorkspace,
      createClient: vi.fn(async () => clientHarness.client),
    });

    try {
      await manager.initialize();

      expect(await readFile(join(activeWorkspace, "keep.txt"), "utf8")).toBe("keep");
      expect(await readdir(join(projectWorkspaceRoot, "demo"))).toEqual(["active"]);
      expect(await readdir(workspaceRoot)).toEqual([]);
      expect(prepareWorkspace).not.toHaveBeenCalled();
      expect(clientHarness.session.exec).not.toHaveBeenCalled();
      expect(clientHarness.client.sessions.observe).toHaveBeenCalledWith("rpc-1");
    } finally {
      await manager.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("close is idempotent and tolerates client detach failures", async () => {
    const clientHarness = createClientHarness();
    clientHarness.session.interrupt = vi.fn(async () => {
      throw new Error("interrupt boom");
    });
    clientHarness.session.unobserve = vi.fn(async () => {
      throw new Error("detach boom");
    });
    clientHarness.client.close = vi.fn(async () => {
      throw new Error("close boom");
    });
    const cleanupWorkspacePath = vi.fn(async () => {});

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
      cleanupWorkspacePath,
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");

    await expect(Promise.all([manager.close(), manager.close(), manager.close()])).resolves.toEqual(
      [undefined, undefined, undefined],
    );

    expect(manager.getSession(created.id)?.state).toBe("waiting-input");
    expect(clientHarness.session.interrupt).toHaveBeenCalledTimes(1);
    expect(clientHarness.session.unobserve).toHaveBeenCalledTimes(1);
    expect(clientHarness.client.close).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspacePath).not.toHaveBeenCalled();

    const logs = manager.getLogs(created.id) ?? [];
    expect(logs.some((entry) => entry.message === "interrupt failed")).toBe(true);
    expect(logs.some((entry) => entry.message === "unobserve failed")).toBe(true);
    expect(logs.some((entry) => entry.message === "close failed")).toBe(true);
  });

  it("emits progress events for bash/edit/write and assistant output", async () => {
    const clientHarness = createClientHarness();
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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

    clientHarness.emitDelta(
      createPatchDelta([
        createToolUiFacetChange("1", {
          type: "bash_started",
          toolCallId: "1",
          command: "npm run check",
          headerTarget: "npm run check",
        }),
      ]),
    );

    clientHarness.emitDelta(
      createPatchDelta([
        createToolUiFacetChange("2", {
          type: "edit_success",
          toolCallId: "2",
          path: "src/core/telegram/adapter.ts",
          headerTarget: "src/core/telegram/adapter.ts",
          oldLength: 1,
          newLength: 2,
          oldText: "a",
          newText: "b",
          uiText: { previewLines: [], fullLines: [] },
        }),
      ]),
    );

    clientHarness.emitDelta(
      createPatchDelta([
        createToolUiFacetChange("3", {
          type: "write_success",
          toolCallId: "3",
          path: "docs/telegram.md",
          headerTarget: "docs/telegram.md",
          bytes: 10,
          lines: 1,
          content: "hello",
          uiText: { previewLines: [], fullLines: [] },
        }),
      ]),
    );

    clientHarness.emitDelta(
      createPatchDelta(
        [
          {
            type: "message.replace",
            message: createAssistantProtocolMessage("h1", [{ type: "text", text: "done" }]),
          },
        ],
        1,
        "assistant-message",
      ),
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-progress",
      turn: { status: "completed", stopReason: "stop" },
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
          event.progress.path === "src/core/telegram/adapter.ts",
      ),
    ).toBe(true);

    expect(
      events.some(
        (event) =>
          event.type === "session-progress" &&
          event.sessionId === created.id &&
          event.progress.type === "wrote-file" &&
          event.progress.path === "docs/telegram.md",
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

  it("emits committed tool-use assistant preambles without streaming draft text", async () => {
    const clientHarness = createClientHarness();
    const manager = createDemoSessionManager(clientHarness);
    const events = [];
    manager.onEvent((event) => {
      events.push(event);
    });
    const { sendPromise } = await startRunningSession(manager);

    clientHarness.emitDelta(
      createPatchDelta(
        [
          {
            type: "message.append",
            message: {
              id: "draft-1",
              state: "draft",
              modelVisible: false,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "streaming draft" }],
                timestamp: 0,
              },
            },
          },
        ],
        1,
        "assistant-stream",
      ),
    );

    clientHarness.emitDelta(
      createPatchDelta(
        [
          {
            type: "message.replace",
            message: createAssistantProtocolMessage(
              "assistant-1",
              [
                { type: "text", text: "I’ll inspect that now." },
                {
                  type: "toolCall",
                  id: "tool-1",
                  name: "bash",
                  arguments: { command: "npm test" },
                },
              ],
              "toolUse",
            ),
          },
        ],
        2,
        "assistant-message",
      ),
    );

    clientHarness.emitDelta(
      createPatchDelta(
        [
          {
            type: "message.replace",
            message: createAssistantProtocolMessage("assistant-2", [
              { type: "text", text: "final answer" },
            ]),
          },
        ],
        3,
        "assistant-message",
      ),
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-progress",
      turn: { status: "completed", stopReason: "stop" },
    });
    await sendPromise;

    expect(assistantProgressTexts(events)).toEqual(["I’ll inspect that now.", "final answer"]);
  });

  it("emits committed assistant progress from assistant-message snapshot resets once", async () => {
    const clientHarness = createClientHarness();
    const manager = createDemoSessionManager(clientHarness);
    const events = [];
    manager.onEvent((event) => {
      events.push(event);
    });
    const { sendPromise } = await startRunningSession(manager);

    const assistantMessage = createAssistantProtocolMessage("assistant-reset", [
      { type: "text", text: "reset preamble" },
    ]);

    const snapshot = createProtocolSnapshot({
      sessionId: "rpc-1",
      revision: 2,
      messages: [assistantMessage],
    });

    clientHarness.emitDelta({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: "rpc-1",
      fromRevision: 1,
      toRevision: 2,
      reason: "assistant-message",
      delta: { type: "snapshot.reset", snapshot },
    });

    clientHarness.emitDelta({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: "rpc-1",
      fromRevision: 2,
      toRevision: 3,
      reason: "assistant-message",
      delta: { type: "snapshot.reset", snapshot: { ...snapshot, revision: 3 } },
    });

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-progress",
      turn: { status: "completed", stopReason: "stop" },
    });
    await sendPromise;

    expect(assistantProgressTexts(events)).toEqual(["reset preamble"]);
  });

  it("does not replay already consumed tool facet progress events", async () => {
    const clientHarness = createClientHarness();
    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
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

    const bashStarted = {
      type: "bash_started",
      toolCallId: "1",
      command: "npm run check",
      headerTarget: "npm run check",
    };
    const writeSuccess = {
      type: "write_success",
      toolCallId: "1",
      path: "docs/telegram.md",
      headerTarget: "docs/telegram.md",
      bytes: 10,
      lines: 1,
      content: "hello",
      uiText: { previewLines: [], fullLines: [] },
    };

    clientHarness.emitDelta(createPatchDelta([createToolUiFacetChange("1", bashStarted)]));
    clientHarness.emitDelta(
      createPatchDelta([createToolUiFacetChange("1", [bashStarted, writeSuccess])]),
    );

    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-progress",
      turn: { status: "completed", stopReason: "stop" },
    });
    await sendPromise;

    const progressEvents = events.filter((event) => event.type === "session-progress");
    expect(
      progressEvents.filter(
        (event) =>
          event.progress.type === "bash-command" && event.progress.command === "npm run check",
      ),
    ).toHaveLength(1);
    expect(
      progressEvents.filter(
        (event) =>
          event.progress.type === "wrote-file" && event.progress.path === "docs/telegram.md",
      ),
    ).toHaveLength(1);
  });

  it("emits lightweight lifecycle events", async () => {
    const clientHarness = createClientHarness();
    clientHarness.submitDeferred.resolve({
      userHistoryEntryId: "history-3",
      turn: { status: "completed", stopReason: "stop" },
    });

    const manager = createTelegramSessionManager({
      projects: {
        demo: {
          repo: "git@example.com:demo.git",
        },
      },
      prepareWorkspace: vi.fn(async () => ({
        workspacePath: "/tmp/ws/demo",
        sessionCwd: "/tmp/ws/demo",
        provisionTargets: [],
      })),
      createClient: vi.fn(async () => clientHarness.client),
    });

    const events = [];
    const unsubscribe = manager.onEvent((event) => {
      events.push(event);
    });

    const created = await manager.createSession({ projectId: "demo" });
    await waitFor(() => manager.getSession(created.id)?.state === "waiting-input");
    await manager.sendMessage(created.id, "hello");
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
    const manager = createTelegramSessionManager({
      projects: {},
      createClient: vi.fn(async () => createClientHarness().client),
    });

    await expect(manager.createSession({ projectId: "missing" })).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_project",
      }),
    );

    await expect(manager.sendMessage("missing", "hi")).rejects.toBeInstanceOf(
      TelegramSessionManagerError,
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
      setReasoning: vi.fn(async (_sessionId, reasoning) => ({
        revision: 2,
        settings: { personaId: "default", reasoning },
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

    const scopedManager = createScopedTelegramSessionManager({
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

    await expect(scopedManager.setReasoning("s-demo-other-owner", "high")).rejects.toEqual(
      expect.objectContaining({
        code: "not_found",
      }),
    );
    await scopedManager.setReasoning("s-demo-owned", "high");
    expect(manager.setReasoning).toHaveBeenCalledWith("s-demo-owned", "high");

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

    const scopedManager = createScopedTelegramSessionManager({
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
