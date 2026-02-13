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
  });
});
