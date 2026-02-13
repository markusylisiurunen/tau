import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AsyncHttpBodyParseError,
  AsyncHttpBodyTooLargeError,
  type AsyncHttpCreateSessionRequest,
  type AsyncHttpSendMessageRequest,
  isRecord,
  readJsonBody,
  readStringField,
  sendError,
  sendOk,
} from "./http_protocol.js";
import {
  type AsyncSessionManager,
  AsyncSessionManagerError,
  type AsyncSessionRecord,
} from "./session_manager.js";

export type AsyncHttpServerOptions = {
  host: string;
  port: number;
  authToken: string;
  sessionManager: AsyncSessionManager;
};

export type AsyncHttpServerHandle = {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
};

type SessionPathRoute =
  | { route: "session"; sessionId: string }
  | { route: "logs"; sessionId: string }
  | { route: "messages"; sessionId: string }
  | { route: "cancel"; sessionId: string };

function isAuthorized(request: IncomingMessage, authToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }

  const expected = Buffer.from(`Bearer ${authToken}`);
  const received = Buffer.from(header);

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function parseSessionPath(pathname: string): SessionPathRoute | "invalid" | undefined {
  const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(pathname);
  if (sessionMatch) {
    const sessionId = decodePathSegment(sessionMatch[1] ?? "");
    if (!sessionId) {
      return "invalid";
    }
    return { route: "session", sessionId };
  }

  const logsMatch = /^\/v1\/sessions\/([^/]+)\/logs$/.exec(pathname);
  if (logsMatch) {
    const sessionId = decodePathSegment(logsMatch[1] ?? "");
    if (!sessionId) {
      return "invalid";
    }
    return { route: "logs", sessionId };
  }

  const messagesMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (messagesMatch) {
    const sessionId = decodePathSegment(messagesMatch[1] ?? "");
    if (!sessionId) {
      return "invalid";
    }
    return { route: "messages", sessionId };
  }

  const cancelMatch = /^\/v1\/sessions\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch) {
    const sessionId = decodePathSegment(cancelMatch[1] ?? "");
    if (!sessionId) {
      return "invalid";
    }
    return { route: "cancel", sessionId };
  }

  return undefined;
}

function mapSessionErrorStatus(error: AsyncSessionManagerError): number {
  switch (error.code) {
    case "not_found":
      return 404;
    case "busy":
      return 409;
    case "invalid_project":
    case "invalid_state":
    case "not_ready":
    case "max_sessions":
      return 400;
  }
}

function readCreateBody(raw: unknown): AsyncHttpCreateSessionRequest | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const projectId = readStringField(raw, "projectId");
  if (!projectId) {
    return undefined;
  }

  const promptValue = raw.prompt;
  if (promptValue !== undefined && typeof promptValue !== "string") {
    return undefined;
  }

  const prompt = typeof promptValue === "string" ? promptValue : undefined;
  return { projectId, ...(prompt === undefined ? {} : { prompt }) };
}

function readSendBody(raw: unknown): AsyncHttpSendMessageRequest | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const text = readStringField(raw, "text");
  if (!text) {
    return undefined;
  }

  return { text };
}

async function readRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | undefined> {
  try {
    return await readJsonBody(request);
  } catch (error) {
    if (error instanceof AsyncHttpBodyParseError) {
      sendError(response, 400, "invalid request body");
      return undefined;
    }

    if (error instanceof AsyncHttpBodyTooLargeError) {
      sendError(response, 413, "request body too large");
      return undefined;
    }

    throw error;
  }
}

function handleManagerError(
  response: ServerResponse,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof AsyncSessionManagerError) {
    sendError(response, mapSessionErrorStatus(error), error.message);
    return;
  }

  sendError(response, 500, fallbackMessage);
}

function serializeSession(session: AsyncSessionRecord): AsyncSessionRecord {
  return { ...session };
}

export async function startAsyncHttpServer(
  options: AsyncHttpServerOptions,
): Promise<AsyncHttpServerHandle> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);

        if (url.pathname === "/healthz") {
          sendOk(response, 200, { status: "ok" });
          return;
        }

        if (url.pathname.startsWith("/v1/") && !isAuthorized(request, options.authToken)) {
          response.setHeader("www-authenticate", 'Bearer realm="tau-async"');
          sendError(response, 401, "unauthorized");
          return;
        }

        if (url.pathname === "/v1/sessions" && method === "POST") {
          try {
            const rawBody = await readRequestBody(request, response);
            if (rawBody === undefined) {
              return;
            }

            const parsed = readCreateBody(rawBody);
            if (!parsed) {
              sendError(response, 400, "invalid request body");
              return;
            }

            const session = await options.sessionManager.createSession(parsed);
            sendOk(response, 201, { session: serializeSession(session) });
          } catch (error) {
            handleManagerError(response, error, "failed to create session");
          }
          return;
        }

        if (url.pathname === "/v1/sessions" && method === "GET") {
          const sessions = options.sessionManager.listSessions().map(serializeSession);
          sendOk(response, 200, { sessions });
          return;
        }

        const route = parseSessionPath(url.pathname);
        if (route === "invalid") {
          sendError(response, 400, "invalid session id");
          return;
        }

        if (!route) {
          sendError(response, 404, "not found");
          return;
        }

        if (route.route === "session" && method === "GET") {
          const session = options.sessionManager.getSession(route.sessionId);
          if (!session) {
            sendError(response, 404, "session not found");
            return;
          }
          sendOk(response, 200, { session: serializeSession(session) });
          return;
        }

        if (route.route === "logs" && method === "GET") {
          const logs = options.sessionManager.getLogs(route.sessionId);
          if (!logs) {
            sendError(response, 404, "session not found");
            return;
          }
          sendOk(response, 200, { logs });
          return;
        }

        if (route.route === "messages" && method === "POST") {
          try {
            const rawBody = await readRequestBody(request, response);
            if (rawBody === undefined) {
              return;
            }

            const parsed = readSendBody(rawBody);
            if (!parsed) {
              sendError(response, 400, "invalid request body");
              return;
            }

            const session = await options.sessionManager.sendMessage(route.sessionId, parsed.text);
            sendOk(response, 200, { session: serializeSession(session) });
          } catch (error) {
            handleManagerError(response, error, "failed to send message");
          }
          return;
        }

        if (route.route === "cancel" && method === "POST") {
          try {
            const session = await options.sessionManager.cancelSession(route.sessionId);
            sendOk(response, 200, { session: serializeSession(session) });
          } catch (error) {
            handleManagerError(response, error, "failed to cancel session");
          }
          return;
        }

        sendError(response, 405, "method not allowed");
      } catch {
        if (!response.headersSent) {
          sendError(response, 500, "internal server error");
          return;
        }

        if (!response.writableEnded) {
          response.end();
        }
      }
    })();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve async server address");
  }

  const host = address.address;
  const port = address.port;

  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      }),
  };
}
