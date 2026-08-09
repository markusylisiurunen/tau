import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  TauSdkClientToolContext,
  TauSdkClientToolResult,
  TauSdkSessionExecOptions,
  TauSdkSessionExecResult,
} from "./types.js";

export const TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION = 2;

const execOptionsSchema = z
  .object({
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    stdinBase64: z.string().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxCaptureBytes: z.number().int().positive().optional(),
  })
  .strict();

const invokeSchema = z
  .object({
    version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
    type: z.literal("invoke"),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    arguments: z.unknown(),
  })
  .strict();

const execRequestSchema = z
  .object({
    version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
    type: z.literal("exec"),
    requestId: z.string().min(1),
    command: z.string().min(1),
    options: execOptionsSchema,
  })
  .strict();

const execCancelSchema = z
  .object({
    version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
    type: z.literal("exec.cancel"),
    requestId: z.string().min(1),
  })
  .strict();

const resultSchema = z
  .object({
    version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
    type: z.literal("result"),
    content: z.string(),
  })
  .strict();

const execResultSchema = z
  .object({
    output: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    closeSignal: z.string().nullable(),
  })
  .strict();

const execResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
      type: z.literal("exec.result"),
      requestId: z.string().min(1),
      ok: z.literal(true),
      result: execResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
      type: z.literal("exec.result"),
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: z.string(),
    })
    .strict(),
]);

export type TauClientToolCommandInvoke = {
  version: 2;
  type: "invoke";
  sessionId: string;
  callId: string;
  arguments: unknown;
};

export type TauClientToolCommandExecRequest = {
  version: 2;
  type: "exec";
  requestId: string;
  command: string;
  options: {
    args?: string[];
    env?: Record<string, string>;
    stdinBase64?: string;
    cwd?: string;
    timeoutMs?: number;
    maxCaptureBytes?: number;
  };
};

export type TauClientToolCommandExecCancel = {
  version: 2;
  type: "exec.cancel";
  requestId: string;
};

export type TauClientToolCommandResult = {
  version: 2;
  type: "result";
  content: string;
};

export type TauClientToolCommandOutput =
  | TauClientToolCommandExecRequest
  | TauClientToolCommandExecCancel
  | TauClientToolCommandResult;

export type TauClientToolCommandExecResponse =
  | {
      version: 2;
      type: "exec.result";
      requestId: string;
      ok: true;
      result: TauSdkSessionExecResult;
    }
  | {
      version: 2;
      type: "exec.result";
      requestId: string;
      ok: false;
      error: string;
    };

export type TauClientToolCommandHandler = (
  args: unknown,
  context: TauSdkClientToolContext,
) => Promise<TauSdkClientToolResult> | TauSdkClientToolResult;

export async function runTauClientToolCommand(handler: TauClientToolCommandHandler): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  const pending = new Map<
    string,
    {
      resolve: (result: TauSdkSessionExecResult) => void;
      reject: (error: unknown) => void;
      signal: AbortSignal;
      onAbort: () => void;
    }
  >();
  let inputEnded = false;
  let requestSequence = 0;
  let writeQueue = Promise.resolve();

  const writeFrame = async (frame: TauClientToolCommandOutput): Promise<void> => {
    const line = `${JSON.stringify(frame)}\n`;
    const write = writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    );
    writeQueue = write.catch(() => undefined);
    await write;
  };

  const rejectPending = (error: unknown): void => {
    for (const request of pending.values()) {
      request.signal.removeEventListener("abort", request.onAbort);
      request.reject(error);
    }
    pending.clear();
  };

  try {
    const first = await iterator.next();
    if (first.done) {
      throw new Error("client-tool command received no invocation");
    }
    const invocation = parseInvokeFrame(first.value);

    let rejectInput: (error: unknown) => void = () => {};
    const inputFailure = new Promise<never>((_resolve, reject) => {
      rejectInput = reject;
    });
    void (async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            inputEnded = true;
            rejectPending(new Error("client-tool command input closed during execution"));
            return;
          }
          const response = parseExecResponseFrame(next.value);
          const request = pending.get(response.requestId);
          if (!request) continue;
          pending.delete(response.requestId);
          request.signal.removeEventListener("abort", request.onAbort);
          if (response.ok) {
            request.resolve(response.result);
          } else {
            request.reject(new Error(response.error));
          }
        }
      } catch (error) {
        inputEnded = true;
        rejectPending(error);
        rejectInput(error);
      }
    })();

    const executionEnvironment = {
      exec: async (
        command: string,
        options: TauSdkSessionExecOptions = {},
      ): Promise<TauSdkSessionExecResult> => {
        if (inputEnded) {
          throw new Error("client-tool command input is closed");
        }
        const { signal: operationSignal, stdin, ...execOptions } = options;
        const signal = operationSignal
          ? AbortSignal.any([controller.signal, operationSignal])
          : controller.signal;
        signal.throwIfAborted();

        const requestId = String(++requestSequence);
        const result = new Promise<TauSdkSessionExecResult>((resolve, reject) => {
          const onAbort = () => {
            pending.delete(requestId);
            void writeFrame({
              version: TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION,
              type: "exec.cancel",
              requestId,
            }).catch(() => undefined);
            reject(signal.reason);
          };
          pending.set(requestId, { resolve, reject, signal, onAbort });
          signal.addEventListener("abort", onAbort, { once: true });
        });

        try {
          await writeFrame({
            version: TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION,
            type: "exec",
            requestId,
            command,
            options: {
              ...execOptions,
              ...(stdin === undefined ? {} : { stdinBase64: stdin.toString("base64") }),
            },
          });
        } catch (error) {
          const request = pending.get(requestId);
          if (request) {
            pending.delete(requestId);
            request.signal.removeEventListener("abort", request.onAbort);
            request.reject(error);
          }
        }
        return await result;
      },
    };

    const handled = Promise.resolve(
      handler(invocation.arguments, {
        sessionId: invocation.sessionId,
        callId: invocation.callId,
        signal: controller.signal,
        executionEnvironment,
      }),
    );
    const result = await Promise.race([handled, inputFailure]);
    const content = typeof result === "string" ? result : result.content;
    await writeFrame({
      version: TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION,
      type: "result",
      content,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    rejectPending(new Error("client-tool command finished"));
    lines.close();
    process.stdin.pause();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

export function parseTauClientToolCommandOutput(value: unknown): TauClientToolCommandOutput {
  const parsed = z
    .discriminatedUnion("type", [execRequestSchema, execCancelSchema, resultSchema])
    .safeParse(value);
  if (!parsed.success) {
    throw new Error("command client tool returned an invalid version-2 protocol frame");
  }
  return parsed.data;
}

export function createTauClientToolCommandInvoke(options: {
  sessionId: string;
  callId: string;
  arguments: unknown;
}): TauClientToolCommandInvoke {
  return {
    version: TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION,
    type: "invoke",
    ...options,
  };
}

export function createTauClientToolCommandExecResponse(options: {
  requestId: string;
  result: TauSdkSessionExecResult;
}): TauClientToolCommandExecResponse;
export function createTauClientToolCommandExecResponse(options: {
  requestId: string;
  error: string;
}): TauClientToolCommandExecResponse;
export function createTauClientToolCommandExecResponse(options: {
  requestId: string;
  result?: TauSdkSessionExecResult;
  error?: string;
}): TauClientToolCommandExecResponse {
  return options.result !== undefined
    ? {
        version: TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION,
        type: "exec.result",
        requestId: options.requestId,
        ok: true,
        result: options.result,
      }
    : {
        version: TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION,
        type: "exec.result",
        requestId: options.requestId,
        ok: false,
        error: options.error ?? "execution failed",
      };
}

function parseInvokeFrame(line: string): TauClientToolCommandInvoke {
  const parsed = invokeSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) {
    throw new Error("client-tool command received an invalid version-2 invocation");
  }
  return parsed.data;
}

function parseExecResponseFrame(line: string): TauClientToolCommandExecResponse {
  const parsed = execResponseSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) {
    throw new Error("client-tool command received an invalid execution response");
  }
  return parsed.data;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("client-tool command received invalid JSON");
  }
}
