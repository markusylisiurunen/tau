import { createInterface } from "node:readline";
import type { TauSessionHost } from "../../host/session_host.js";
import {
  SessionProtocolHandler,
  type SessionProtocolHandlerOptions,
} from "../../host/session_protocol_handler.js";
import {
  createSessionProtocolErrorResponse,
  parseSessionProtocolRequestLine,
  type SessionProtocolParseFailure,
  serializeSessionProtocolMessage,
} from "../../protocol/session_protocol.js";

export type RpcServerOptions = {
  host: TauSessionHost;
  send: (line: string) => void;
};

export type RunRpcServerOptions = {
  host: TauSessionHost;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  signal?: AbortSignal;
};

export class RpcServer {
  private readonly handler: SessionProtocolHandler;
  private readonly send: (line: string) => void;
  private closed = false;

  constructor(options: RpcServerOptions) {
    this.send = options.send;
    this.handler = new SessionProtocolHandler({
      host: options.host,
      send: (message) => this.send(serializeSessionProtocolMessage(message)),
    } satisfies SessionProtocolHandlerOptions);
  }

  async handleLine(line: string): Promise<void> {
    if (this.closed) {
      return;
    }

    const parsed = parseSessionProtocolRequestLine(line);
    if (!parsed.ok) {
      this.sendParseFailure(parsed);
      return;
    }

    await this.handler.handleRequest(parsed.request);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.handler.close("shutdown-host");
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  private sendParseFailure(parsed: SessionProtocolParseFailure): void {
    this.send(
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
}

export async function runRpcServer(options: RunRpcServerOptions): Promise<void> {
  const server = new RpcServer({
    host: options.host,
    send: (line) => {
      options.output.write(`${line}\n`);
    },
  });

  const lineReader = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const inFlightHandlers = new Set<Promise<void>>();
  let firstError: unknown;
  let stopRequested = false;

  const trackInFlight = (promise: Promise<void>) => {
    inFlightHandlers.add(promise);
    void promise
      .catch((error) => {
        if (firstError === undefined) {
          firstError = error;
        }
      })
      .finally(() => {
        inFlightHandlers.delete(promise);
      });
  };

  const requestStop = () => {
    if (stopRequested) {
      return;
    }

    stopRequested = true;
    lineReader.close();

    if (typeof options.input.pause === "function") {
      options.input.pause();
    }
  };

  const onLine = (line: string) => {
    const handler = server.handleLine(line);
    trackInFlight(handler);
  };

  const onAbort = () => {
    requestStop();
  };

  lineReader.on("line", onLine);

  const closePromise = new Promise<void>((resolve) => {
    lineReader.once("close", resolve);
  });

  if (options.signal) {
    if (options.signal.aborted) {
      requestStop();
    }
    options.signal.addEventListener("abort", onAbort);
  }

  try {
    await closePromise;
  } finally {
    lineReader.off("line", onLine);
    options.signal?.removeEventListener("abort", onAbort);

    await server.shutdown();

    if (inFlightHandlers.size > 0) {
      await Promise.allSettled([...inFlightHandlers]);
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}
