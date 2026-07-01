import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assertNever } from "../utils/never.js";
import {
  type AsyncCronRunRecord,
  type AsyncCronScheduler,
  AsyncCronSchedulerError,
} from "./cron.js";
import {
  AsyncHttpBodyParseError,
  AsyncHttpBodyTooLargeError,
  AsyncHttpRequestParseError,
  decodeAsyncHttpRoute,
  parseCreateSessionBody,
  parseCronRunsQuery,
  parseSendMessageBody,
  readJsonBody,
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

        if (url.pathname.startsWith("/v1/") && !isAuthorized(request, options.authToken)) {
          response.setHeader("www-authenticate", 'Bearer realm="tau-async"');
          sendError(response, 401, "unauthorized");
          return;
        }

        let route: ReturnType<typeof decodeAsyncHttpRoute>;
        try {
          route = decodeAsyncHttpRoute(method, url.pathname);
        } catch (error) {
          if (error instanceof AsyncHttpRequestParseError) {
            sendError(response, error.statusCode, error.message);
            return;
          }
          throw error;
        }

        if (route === "not-found") {
          sendError(response, 404, "not found");
          return;
        }

        if (route === "method-not-allowed") {
          sendError(response, 405, "method not allowed");
          return;
        }

        switch (route.route) {
          case "healthz": {
            sendOk(response, 200, { status: "ok" });
            return;
          }

          case "create-session": {
            try {
              const rawBody = await readRequestBody(request, response);
              if (rawBody === undefined) {
                return;
              }

              const parsed = parseCreateSessionBody(rawBody);
              const session = await options.sessionManager.createSession(parsed);
              sendOk(response, 201, { session: serializeSession(session) });
            } catch (error) {
              if (error instanceof AsyncHttpRequestParseError) {
                sendError(response, error.statusCode, error.message);
                return;
              }

              handleManagerError(response, error, "failed to create session");
            }
            return;
          }

          case "list-sessions": {
            const sessions = options.sessionManager.listSessions().map(serializeSession);
            sendOk(response, 200, { sessions });
            return;
          }

          case "get-session": {
            const session = options.sessionManager.getSession(route.sessionId);
            if (!session) {
              sendError(response, 404, "session not found");
              return;
            }
            sendOk(response, 200, { session: serializeSession(session) });
            return;
          }

          case "get-session-logs": {
            const logs = options.sessionManager.getLogs(route.sessionId);
            if (!logs) {
              sendError(response, 404, "session not found");
              return;
            }
            sendOk(response, 200, { logs });
            return;
          }

          case "send-message": {
            try {
              const rawBody = await readRequestBody(request, response);
              if (rawBody === undefined) {
                return;
              }

              const parsed = parseSendMessageBody(rawBody);
              const sendOptions =
                parsed.mode !== undefined || parsed.additionalSystemMessage !== undefined
                  ? {
                      ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
                      ...(parsed.additionalSystemMessage === undefined
                        ? {}
                        : { additionalSystemMessage: parsed.additionalSystemMessage }),
                    }
                  : undefined;
              const session = await options.sessionManager.sendMessage(
                route.sessionId,
                parsed.text,
                sendOptions,
              );
              sendOk(response, 200, { session: serializeSession(session) });
            } catch (error) {
              if (error instanceof AsyncHttpRequestParseError) {
                sendError(response, error.statusCode, error.message);
                return;
              }

              handleManagerError(response, error, "failed to send message");
            }
            return;
          }

          case "interrupt-session": {
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

          case "list-cron-jobs": {
            const cronScheduler = options.cronScheduler;
            if (!cronScheduler) {
              sendError(response, 404, "cron scheduler not enabled");
              return;
            }

            sendOk(response, 200, { jobs: cronScheduler.listJobs() });
            return;
          }

          case "list-cron-runs": {
            const cronScheduler = options.cronScheduler;
            if (!cronScheduler) {
              sendError(response, 404, "cron scheduler not enabled");
              return;
            }

            try {
              const query = parseCronRunsQuery(url.searchParams);
              const runs = cronScheduler.listRuns(query).map(serializeCronRun);
              sendOk(response, 200, { runs });
            } catch (error) {
              if (error instanceof AsyncHttpRequestParseError) {
                sendError(response, error.statusCode, error.message);
                return;
              }

              throw error;
            }
            return;
          }

          case "trigger-cron-job": {
            const cronScheduler = options.cronScheduler;
            if (!cronScheduler) {
              sendError(response, 404, "cron scheduler not enabled");
              return;
            }

            try {
              const run = await cronScheduler.triggerJobNow(route.jobId);
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

          default:
            assertNever(route);
        }
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
