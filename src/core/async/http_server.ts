import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type AsyncCronRunRecord,
  type AsyncCronScheduler,
  AsyncCronSchedulerError,
} from "./cron.js";
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
  cronScheduler?: AsyncCronScheduler;
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
  | { route: "interrupt"; sessionId: string };

type CronPathRoute =
  | { route: "cron-jobs" }
  | { route: "cron-runs" }
  | { route: "cron-run"; jobId: string };

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
    const segment = sessionMatch[1];
    if (segment === undefined) {
      return "invalid";
    }

    const sessionId = decodePathSegment(segment);
    if (!sessionId) {
      return "invalid";
    }
    return { route: "session", sessionId };
  }

  const logsMatch = /^\/v1\/sessions\/([^/]+)\/logs$/.exec(pathname);
  if (logsMatch) {
    const segment = logsMatch[1];
    if (segment === undefined) {
      return "invalid";
    }

    const sessionId = decodePathSegment(segment);
    if (!sessionId) {
      return "invalid";
    }
    return { route: "logs", sessionId };
  }

  const messagesMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (messagesMatch) {
    const segment = messagesMatch[1];
    if (segment === undefined) {
      return "invalid";
    }

    const sessionId = decodePathSegment(segment);
    if (!sessionId) {
      return "invalid";
    }
    return { route: "messages", sessionId };
  }

  const interruptMatch = /^\/v1\/sessions\/([^/]+)\/interrupt$/.exec(pathname);
  if (interruptMatch) {
    const segment = interruptMatch[1];
    if (segment === undefined) {
      return "invalid";
    }

    const sessionId = decodePathSegment(segment);
    if (!sessionId) {
      return "invalid";
    }
    return { route: "interrupt", sessionId };
  }

  return undefined;
}

function parseCronPath(pathname: string): CronPathRoute | "invalid" | undefined {
  if (pathname === "/v1/cron/jobs") {
    return { route: "cron-jobs" };
  }

  if (pathname === "/v1/cron/runs") {
    return { route: "cron-runs" };
  }

  const manualRunMatch = /^\/v1\/cron\/jobs\/([^/]+)\/run$/.exec(pathname);
  if (manualRunMatch) {
    const segment = manualRunMatch[1];
    if (segment === undefined) {
      return "invalid";
    }

    const jobId = decodePathSegment(segment);
    if (!jobId) {
      return "invalid";
    }

    return { route: "cron-run", jobId };
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

function serializeCronRun(run: AsyncCronRunRecord): AsyncCronRunRecord {
  return { ...run };
}

function parsePositiveLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export async function startAsyncHttpServer(
  options: AsyncHttpServerOptions,
): Promise<AsyncHttpServerHandle> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (typeof request.method !== "string") {
          sendError(response, 400, "invalid request method");
          return;
        }

        if (typeof request.url !== "string") {
          sendError(response, 400, "invalid request url");
          return;
        }

        const method = request.method;
        const url = new URL(request.url, `http://${options.host}:${options.port}`);

        if (url.pathname === "/healthz") {
          sendOk(response, 200, { status: "ok" });
          return;
        }

        if (url.pathname.startsWith("/v1/") && !isAuthorized(request, options.authToken)) {
          response.setHeader("www-authenticate", 'Bearer realm="tau-async"');
          sendError(response, 401, "unauthorized");
          return;
        }

        const cronRoute = parseCronPath(url.pathname);
        if (cronRoute === "invalid") {
          sendError(response, 400, "invalid cron job id");
          return;
        }

        if (cronRoute) {
          const cronScheduler = options.cronScheduler;
          if (!cronScheduler) {
            sendError(response, 404, "cron scheduler not enabled");
            return;
          }

          if (cronRoute.route === "cron-jobs" && method === "GET") {
            sendOk(response, 200, { jobs: cronScheduler.listJobs() });
            return;
          }

          if (cronRoute.route === "cron-runs" && method === "GET") {
            const limitRaw = url.searchParams.get("limit");
            const limit = parsePositiveLimit(limitRaw);
            if (limitRaw !== null && limit === undefined) {
              sendError(response, 400, "invalid limit query parameter");
              return;
            }

            const jobId = url.searchParams.get("jobId")?.trim() || undefined;
            const runs = cronScheduler
              .listRuns({
                ...(jobId ? { jobId } : {}),
                ...(limit ? { limit } : {}),
              })
              .map(serializeCronRun);
            sendOk(response, 200, { runs });
            return;
          }

          if (cronRoute.route === "cron-run" && method === "POST") {
            try {
              const run = await cronScheduler.triggerJobNow(cronRoute.jobId);
              sendOk(response, 200, { run: serializeCronRun(run) });
            } catch (error) {
              if (error instanceof AsyncCronSchedulerError && error.code === "not_found") {
                sendError(response, 404, "cron job not found");
                return;
              }

              sendError(response, 500, "failed to trigger cron job");
            }
            return;
          }

          sendError(response, 405, "method not allowed");
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

        if (route.route === "interrupt" && method === "POST") {
          try {
            const interrupted = await options.sessionManager.interruptSession(route.sessionId);
            sendOk(response, 200, {
              session: serializeSession(interrupted.session),
              interrupted: interrupted.interrupted,
              isTurnRunning: interrupted.isTurnRunning,
            });
          } catch (error) {
            handleManagerError(response, error, "failed to interrupt session");
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
