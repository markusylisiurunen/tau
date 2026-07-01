import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { TauSessionHost } from "../../host/session_host.js";
import { SessionProtocolHandler } from "../../host/session_protocol_handler.js";
import {
  createSessionProtocolErrorResponse,
  parseSessionProtocolRequestLine,
  type SessionProtocolParseFailure,
  serializeSessionProtocolMessage,
} from "../../protocol/session_protocol.js";

export type WebSocketSessionServerOptions = {
  host: TauSessionHost;
  authToken?: string;
};

export type RunWebSocketSessionServerOptions = {
  host: TauSessionHost;
  hostname: string;
  port: number;
  authToken?: string;
  signal?: AbortSignal;
  onListening?: (address: WebSocketSessionServerAddress) => void;
};

export type WebSocketSessionServerAddress = {
  hostname: string;
  port: number;
};

type ClientState = {
  socket: WebSocket;
  handler: SessionProtocolHandler;
  inFlightHandlers: Set<Promise<void>>;
};

export class WebSocketSessionServer {
  private readonly host: TauSessionHost;
  private readonly authToken?: string;
  private readonly clients = new Set<ClientState>();
  private closed = false;

  constructor(options: WebSocketSessionServerOptions) {
    this.host = options.host;
    this.authToken = options.authToken;
  }

  accept(socket: WebSocket, requestUrl: string | undefined): void {
    if (this.closed) {
      socket.close(1012, "server closed");
      return;
    }

    if (!this.isAuthorized(requestUrl)) {
      socket.close(1008, "unauthorized");
      return;
    }

    const state: ClientState = {
      socket,
      inFlightHandlers: new Set(),
      handler: new SessionProtocolHandler({
        host: this.host,
        send: (message) => {
          this.sendSocketMessage(socket, serializeSessionProtocolMessage(message));
        },
      }),
    };
    this.clients.add(state);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "session protocol requires text messages");
        return;
      }

      const handler = this.handleSocketMessage(state, data.toString("utf8"));
      state.inFlightHandlers.add(handler);
      void handler
        .catch(() => {
          if (socket.readyState === socket.OPEN) {
            socket.close(1011, "session protocol request failed");
          }
        })
        .finally(() => {
          state.inFlightHandlers.delete(handler);
        });
    });

    socket.once("close", () => {
      this.clients.delete(state);
      void this.closeClient(state);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const states = [...this.clients];
    this.clients.clear();
    await Promise.allSettled(
      states.map(async (state) => {
        state.socket.terminate();
        await this.closeClient(state, { mode: "interrupt" });
      }),
    );
    await this.host.shutdown();
  }

  private async handleSocketMessage(state: ClientState, payload: string): Promise<void> {
    const parsed = parseSessionProtocolRequestLine(payload);
    if (!parsed.ok) {
      this.sendParseFailure(state.socket, parsed);
      return;
    }

    await state.handler.handleRequest(parsed.request);
  }

  private async closeClient(
    state: ClientState,
    options: { mode?: "detach" | "interrupt"; waitForInFlight?: boolean } = {},
  ): Promise<void> {
    await state.handler.close(options.mode ?? (this.closed ? "interrupt" : "detach"));
    if (options.waitForInFlight !== false && state.inFlightHandlers.size > 0) {
      await Promise.allSettled([...state.inFlightHandlers]);
    }
  }

  private sendParseFailure(socket: WebSocket, parsed: SessionProtocolParseFailure): void {
    this.sendSocketMessage(
      socket,
      serializeSessionProtocolMessage(
        createSessionProtocolErrorResponse(
          parsed.id,
          parsed.error.code,
          parsed.error.message,
          parsed.error.data,
        ),
      ),
    );
  }

  private sendSocketMessage(socket: WebSocket, message: string): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }

    try {
      socket.send(message);
    } catch {
      socket.close(1011, "session protocol send failed");
    }
  }

  private isAuthorized(requestUrl: string | undefined): boolean {
    if (this.authToken === undefined) {
      return true;
    }

    if (requestUrl === undefined) {
      return false;
    }

    const url = new URL(requestUrl, "ws://localhost");
    return url.searchParams.get("tau_token") === this.authToken;
  }
}

export async function runWebSocketSessionServer(
  options: RunWebSocketSessionServerOptions,
): Promise<void> {
  const httpServer = createServer();
  const socketServer = new WebSocketServer({ server: httpServer });
  const sessionServer = new WebSocketSessionServer({
    host: options.host,
    authToken: options.authToken,
  });

  socketServer.on("connection", (socket, request) => {
    sessionServer.accept(socket, request.url);
  });

  const listeningPromise = new Promise<WebSocketSessionServerAddress>((resolve, reject) => {
    const rejectListening = (error: Error) => {
      httpServer.off("error", rejectListening);
      socketServer.off("error", rejectListening);
      reject(error);
    };
    httpServer.once("error", rejectListening);
    socketServer.once("error", rejectListening);
    httpServer.listen(options.port, options.hostname, () => {
      httpServer.off("error", rejectListening);
      socketServer.off("error", rejectListening);
      const address = httpServer.address();
      if (typeof address === "object" && address !== null) {
        resolve({
          hostname: options.hostname,
          port: address.port,
        });
        return;
      }

      reject(new Error("websocket server did not expose a TCP address"));
    });
  });

  let didStartListening = false;
  let removeAbortListener: (() => void) | undefined;

  try {
    const address = await listeningPromise;
    didStartListening = true;
    options.onListening?.(address);

    const stopPromise = new Promise<void>((resolve) => {
      const requestStop = () => resolve();
      if (options.signal) {
        if (options.signal.aborted) {
          resolve();
          return;
        }
        options.signal.addEventListener("abort", requestStop, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", requestStop);
      }
    });

    await stopPromise;
  } finally {
    removeAbortListener?.();
    await sessionServer.close();
    if (didStartListening) {
      await new Promise<void>((resolve, reject) => {
        socketServer.close((socketError) => {
          if (socketError) {
            reject(socketError);
            return;
          }

          httpServer.close((httpError) => {
            if (httpError) {
              reject(httpError);
              return;
            }
            resolve();
          });
        });
      });
    }
  }
}
