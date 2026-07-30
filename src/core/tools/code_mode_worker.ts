import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { truncateToBytesFromEnd } from "../utils/truncate.js";
import { type BashExecutionResult, DEFAULT_COMMAND_CAPTURE_BYTES } from "./execution_backend.js";

const MAX_BRIDGE_REQUESTS = 64;
const MAX_CONCURRENT_BRIDGE_REQUESTS = 4;

export type CodeModeBridgeRequest = {
  id: number;
  method: string;
  argsJson: string;
};

type CodeModeWorkerRequest = { type: "request" } & CodeModeBridgeRequest;

type CodeModeWorkerOptions = {
  sandboxRunnerUrl: URL;
  workerData: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  handleRequest(request: CodeModeBridgeRequest, signal: AbortSignal): Promise<unknown>;
};

function appendCapture(current: string, chunk: string): string {
  return truncateToBytesFromEnd(current + chunk, DEFAULT_COMMAND_CAPTURE_BYTES);
}

function serializeError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

function isWorkerRequest(value: unknown): value is CodeModeWorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === "request" &&
    typeof request.id === "number" &&
    Number.isSafeInteger(request.id) &&
    request.id > 0 &&
    typeof request.method === "string" &&
    typeof request.argsJson === "string"
  );
}

export function executeCodeModeWorker(
  options: CodeModeWorkerOptions,
): Promise<BashExecutionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.sandboxRunnerUrl, {
      workerData: options.workerData,
      env: {
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
        ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let terminating = false;
    let bridgeRequestCount = 0;
    let workerError: Error | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const requestController = new AbortController();
    const requestSignal = AbortSignal.any([options.signal, requestController.signal]);
    const inFlightRequests = new Set<Promise<void>>();

    const appendOutput = (target: "stdout" | "stderr", text: string): void => {
      if (!text) return;
      output = appendCapture(output, text);
      if (target === "stdout") {
        stdout = appendCapture(stdout, text);
      } else {
        stderr = appendCapture(stderr, text);
      }
    };
    const capture = (target: "stdout" | "stderr", decoder: StringDecoder, chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > DEFAULT_COMMAND_CAPTURE_BYTES) truncated = true;
      appendOutput(target, decoder.write(chunk));
    };
    const settleRequests = async (): Promise<void> => {
      requestController.abort();
      while (inFlightRequests.size > 0) {
        await Promise.allSettled([...inFlightRequests]);
      }
    };
    const terminate = (reason: "abort" | "timeout"): void => {
      if (terminating) return;
      terminating = true;
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      requestController.abort();
      void worker.terminate().catch(() => {});
    };
    const abortHandler = (): void => terminate("abort");
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timeout.unref?.();

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abortHandler);
    };
    const failWorker = (error: Error): void => {
      if (workerError) return;
      workerError = error;
      requestController.abort();
      void worker.terminate().catch(() => {});
    };
    const postResponse = (message: Record<string, unknown>): void => {
      if (settled || terminating || workerError) return;
      try {
        worker.postMessage(message);
      } catch {}
    };

    worker.stdout.on("data", (chunk: Buffer) => capture("stdout", stdoutDecoder, chunk));
    worker.stderr.on("data", (chunk: Buffer) => capture("stderr", stderrDecoder, chunk));
    worker.on("message", (message: unknown) => {
      if (settled || terminating || workerError) return;
      if (!isWorkerRequest(message)) {
        failWorker(new Error("code-mode sandbox sent an invalid bridge request"));
        return;
      }
      bridgeRequestCount += 1;
      if (bridgeRequestCount > MAX_BRIDGE_REQUESTS) {
        failWorker(new Error(`code-mode sandbox exceeded ${MAX_BRIDGE_REQUESTS} bridge requests`));
        return;
      }
      if (inFlightRequests.size >= MAX_CONCURRENT_BRIDGE_REQUESTS) {
        failWorker(
          new Error(
            `code-mode sandbox exceeded ${MAX_CONCURRENT_BRIDGE_REQUESTS} concurrent bridge requests`,
          ),
        );
        return;
      }
      const request = options.handleRequest(message, requestSignal).then(
        (value) => postResponse({ type: "response", id: message.id, ok: true, value }),
        (error) =>
          postResponse({
            type: "response",
            id: message.id,
            ok: false,
            error: serializeError(error),
          }),
      );
      inFlightRequests.add(request);
      void request.then(() => inFlightRequests.delete(request));
    });
    worker.once("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
      requestController.abort();
    });
    worker.once("exit", (workerExitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        await Promise.allSettled([finished(worker.stdout), finished(worker.stderr)]);
        appendOutput("stdout", stdoutDecoder.end());
        appendOutput("stderr", stderrDecoder.end());
        await settleRequests();
        if (workerError && !terminating) {
          reject(workerError);
          return;
        }
        resolve({
          output,
          stdout,
          stderr,
          exitCode: aborted || timedOut ? null : workerExitCode,
          truncated,
          timedOut,
          aborted,
          closeSignal: null,
        });
      })();
    });

    if (options.signal.aborted) {
      abortHandler();
    } else {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}
