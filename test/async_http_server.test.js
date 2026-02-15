import { afterEach, describe, expect, it, vi } from "vitest";
import { startAsyncHttpServer } from "../dist/core/async/http_server.js";

const handles = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    await handle.close();
  }
});

function createManager() {
  return {
    createSession: vi.fn(async ({ projectId, prompt }) => ({
      id: "s1",
      projectId,
      state: "queued",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...(prompt ? { error: prompt } : {}),
    })),
    listSessions: vi.fn(() => [
      {
        id: "s1",
        projectId: "demo",
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]),
    getSession: vi.fn(() => undefined),
    getLogs: vi.fn(() => []),
    sendMessage: vi.fn(async () => ({
      id: "s1",
      projectId: "demo",
      state: "waiting-input",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    })),
    interruptSession: vi.fn(async () => ({
      session: {
        id: "s1",
        projectId: "demo",
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      interrupted: true,
      isTurnRunning: true,
    })),
    cancelSession: vi.fn(async () => ({
      id: "s1",
      projectId: "demo",
      state: "canceled",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    })),
    onEvent: vi.fn(() => () => {}),
  };
}

function createCronScheduler() {
  return {
    listJobs: vi.fn(() => [
      {
        id: "nightly",
        projectId: "demo",
        schedule: "0 2 * * *",
        prompt: "check docs drift",
      },
    ]),
    listRuns: vi.fn(() => [
      {
        id: "run-1",
        jobId: "nightly",
        projectId: "demo",
        schedule: "0 2 * * *",
        trigger: "manual",
        triggeredAt: "2024-01-01T00:00:00.000Z",
        status: "session-created",
        sessionId: "s1",
        sessionState: "queued",
      },
    ]),
    triggerJobNow: vi.fn(async () => ({
      id: "run-2",
      jobId: "nightly",
      projectId: "demo",
      schedule: "0 2 * * *",
      trigger: "manual",
      triggeredAt: "2024-01-01T00:01:00.000Z",
      status: "session-created",
      sessionId: "s2",
      sessionState: "queued",
    })),
    close: vi.fn(async () => {}),
  };
}

describe("async http server", () => {
  it("allows /healthz without auth", async () => {
    const manager = createManager();
    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const healthz = await fetch(`${handle.baseUrl}/healthz`);
    expect(healthz.status).toBe(200);
  });

  it("accepts valid bearer token and rejects invalid token", async () => {
    const manager = createManager();
    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const unauthorized = await fetch(`${handle.baseUrl}/v1/sessions`, {
      headers: {
        authorization: "Bearer wrong",
      },
    });
    expect(unauthorized.status).toBe(401);

    const listed = await fetch(`${handle.baseUrl}/v1/sessions`, {
      headers: {
        authorization: "Bearer secret",
      },
    });
    expect(listed.status).toBe(200);

    const listPayload = await listed.json();
    expect(listPayload.ok).toBe(true);
    expect(listPayload.data.sessions[0].id).toBe("s1");

    const created = await fetch(`${handle.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: "demo", prompt: "hello" }),
    });

    expect(created.status).toBe(201);
    expect(manager.createSession).toHaveBeenCalledWith({ projectId: "demo", prompt: "hello" });

    const interrupted = await fetch(`${handle.baseUrl}/v1/sessions/s1/interrupt`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(interrupted.status).toBe(200);
    const interruptedPayload = await interrupted.json();
    expect(interruptedPayload).toEqual({
      ok: true,
      data: {
        session: {
          id: "s1",
          projectId: "demo",
          state: "running",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        interrupted: true,
        isTurnRunning: true,
      },
    });
    expect(manager.interruptSession).toHaveBeenCalledWith("s1");
  });

  it("returns 400 for malformed json request bodies", async () => {
    const manager = createManager();
    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const response = await fetch(`${handle.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
  });

  it("returns 413 for oversized json request bodies", async () => {
    const manager = createManager();
    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const response = await fetch(`${handle.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: "x".repeat(1_000_001),
    });

    expect(response.status).toBe(413);
  });

  it("returns 400 for malformed session id path encoding", async () => {
    const manager = createManager();
    manager.getSession = vi.fn(() => ({
      id: "s1",
      projectId: "demo",
      state: "waiting-input",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    }));

    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const response = await fetch(`${handle.baseUrl}/v1/sessions/%E0%A4%A`, {
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(response.status).toBe(400);
  });

  it("supports cron inspection and manual trigger routes when scheduler is enabled", async () => {
    const manager = createManager();
    const cronScheduler = createCronScheduler();

    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
      cronScheduler,
    });
    handles.push(handle);

    const jobsResponse = await fetch(`${handle.baseUrl}/v1/cron/jobs`, {
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(jobsResponse.status).toBe(200);
    const jobsPayload = await jobsResponse.json();
    expect(jobsPayload.data.jobs[0].id).toBe("nightly");

    const runsResponse = await fetch(`${handle.baseUrl}/v1/cron/runs?jobId=nightly`, {
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(runsResponse.status).toBe(200);
    expect(cronScheduler.listRuns).toHaveBeenCalledWith({ jobId: "nightly" });

    const runResponse = await fetch(`${handle.baseUrl}/v1/cron/jobs/nightly/run`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(runResponse.status).toBe(200);
    expect(cronScheduler.triggerJobNow).toHaveBeenCalledWith("nightly");
  });

  it("returns 404 for cron routes when scheduler is disabled", async () => {
    const manager = createManager();

    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const response = await fetch(`${handle.baseUrl}/v1/cron/jobs`, {
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(response.status).toBe(404);
  });

  it("returns 500 when unexpected errors escape handler branches", async () => {
    const manager = createManager();
    manager.listSessions = vi.fn(() => {
      throw new Error("boom");
    });

    const handle = await startAsyncHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "secret",
      sessionManager: manager,
    });
    handles.push(handle);

    const response = await fetch(`${handle.baseUrl}/v1/sessions`, {
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(response.status).toBe(500);
  });
});
