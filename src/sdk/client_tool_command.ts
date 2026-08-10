import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import {
  SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES,
  SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES,
} from "../protocol/session_protocol.js";
import type {
  TauSdkClientToolContext,
  TauSdkClientToolResult,
  TauSdkSessionExecOptions,
  TauSdkSessionExecResult,
} from "./types.js";

export const TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION = 3;
export const TAU_CLIENT_TOOL_COMMAND_MAX_RESULT_BYTES = 1024 * 1024;
export const TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES = 24 * 1024 * 1024;
export const TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_BYTES = 192 * 1024 * 1024;
export const TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAMES = 512;

const maxExecStdinBase64Length = 4 * Math.ceil(SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES / 3);

const execOptionsSchema = z
  .object({
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    stdinBase64: z
      .string()
      .max(maxExecStdinBase64Length)
      .refine(isValidBase64)
      .refine((value) => decodedBase64ByteLength(value) <= SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES)
      .optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxCaptureBytes: z
      .number()
      .int()
      .positive()
      .max(SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES)
      .optional(),
  })
  .strict();

const invokeSchema = z
  .object({
    version: z.literal(TAU_CLIENT_TOOL_COMMAND_PROTOCOL_VERSION),
    type: z.literal("invoke"),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
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
    content: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= TAU_CLIENT_TOOL_COMMAND_MAX_RESULT_BYTES,
      ),
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
  version: 3;
  type: "invoke";
  sessionId: string;
  agentId: string;
  callId: string;
  arguments: unknown;
};

export type TauClientToolCommandExecRequest = {
  version: 3;
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
  version: 3;
  type: "exec.cancel";
  requestId: string;
};

export type TauClientToolCommandResult = {
  version: 3;
  type: "result";
  content: string;
};

export type TauClientToolCommandOutput =
  | TauClientToolCommandExecRequest
  | TauClientToolCommandExecCancel
  | TauClientToolCommandResult;

export type TauClientToolCommandExecResponse =
  | {
      version: 3;
      type: "exec.result";
      requestId: string;
      ok: true;
      result: TauSdkSessionExecResult;
    }
  | {
      version: 3;
      type: "exec.result";
      requestId: string;
      ok: false;
      error: string;
    };

export type TauClientToolCommandHandler = (
  args: unknown,
  context: TauSdkClientToolContext,
) => Promise<TauSdkClientToolResult> | TauSdkClientToolResult;

export type TauClientToolCommandOutputEncoder = {
  encode(frame: TauClientToolCommandOutput): string;
};

export type TauClientToolCommandOutputDecoder = {
  push(chunk: Buffer | string): TauClientToolCommandOutput[];
  end(): TauClientToolCommandOutput[];
};

export function createTauClientToolCommandOutputEncoder(): TauClientToolCommandOutputEncoder {
  let totalBytes = 0;
  let totalFrames = 0;
  return {
    encode(frame) {
      const line = serializeTauClientToolCommandOutput(frame);
      totalBytes += Buffer.byteLength(line, "utf8");
      totalFrames += 1;
      assertProtocolTotals(totalBytes, totalFrames);
      return line;
    },
  };
}

export function createTauClientToolCommandOutputDecoder(): TauClientToolCommandOutputDecoder {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let totalBytes = 0;
  let totalFrames = 0;

  const consume = (text: string, flush: boolean): TauClientToolCommandOutput[] => {
    buffer += text;
    const frames: TauClientToolCommandOutput[] = [];
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      assertProtocolFrameBytes(Buffer.byteLength(rawLine, "utf8"));
      const line = rawLine.trim();
      if (!line) continue;
      frames.push(parseTauClientToolCommandOutputLine(line));
      totalFrames += 1;
      assertProtocolTotals(totalBytes, totalFrames);
    }

    if (flush && buffer.trim()) {
      frames.push(parseTauClientToolCommandOutputLine(buffer.trim()));
      totalFrames += 1;
      buffer = "";
      assertProtocolTotals(totalBytes, totalFrames);
    } else if (
      Buffer.byteLength(buffer, "utf8") > TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES
    ) {
      buffer = "";
      throw new Error(
        `command client tool exceeded the ${TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES}-byte protocol frame limit`,
      );
    }
    return frames;
  };

  return {
    push(chunk) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += bytes.byteLength;
      assertProtocolTotals(totalBytes, totalFrames);
      return consume(decoder.write(bytes), false);
    },
    end() {
      return consume(decoder.end(), true);
    },
  };
}

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
  let stoppingInput = false;
  let requestSequence = 0;
  let writeQueue = Promise.resolve();
  const outputEncoder = createTauClientToolCommandOutputEncoder();

  const writeFrame = async (frame: TauClientToolCommandOutput): Promise<void> => {
    const line = outputEncoder.encode(frame);
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
            if (stoppingInput) return;
            const error = new Error("client-tool command input closed during execution");
            inputEnded = true;
            controller.abort(error);
            rejectPending(error);
            rejectInput(error);
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
        if (stoppingInput) return;
        inputEnded = true;
        controller.abort(error);
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
        agentId: invocation.agentId,
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
    stoppingInput = true;
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
    throw new Error("command client tool returned an invalid version-3 protocol frame");
  }
  return parsed.data;
}

export function parseTauClientToolCommandOutputLine(line: string): TauClientToolCommandOutput {
  assertProtocolFrameBytes(Buffer.byteLength(line, "utf8"));
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("command client tool returned invalid JSON protocol framing");
  }
  return parseTauClientToolCommandOutput(value);
}

export function serializeTauClientToolCommandOutput(frame: TauClientToolCommandOutput): string {
  const line = JSON.stringify(parseTauClientToolCommandOutput(frame));
  assertProtocolFrameBytes(Buffer.byteLength(line, "utf8"));
  return `${line}\n`;
}

export function createTauClientToolCommandInvoke(options: {
  sessionId: string;
  agentId: string;
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

function assertProtocolFrameBytes(bytes: number): void {
  if (bytes > TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES) {
    throw new Error(
      `command client tool exceeded the ${TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES}-byte protocol frame limit`,
    );
  }
}

function assertProtocolTotals(bytes: number, frames: number): void {
  if (bytes > TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_BYTES) {
    throw new Error(
      `command client tool exceeded the ${TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_BYTES}-byte protocol traffic limit`,
    );
  }
  if (frames > TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAMES) {
    throw new Error(
      `command client tool exceeded the ${TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAMES}-frame protocol limit`,
    );
  }
}

function isValidBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function parseInvokeFrame(line: string): TauClientToolCommandInvoke {
  const parsed = invokeSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) {
    throw new Error("client-tool command received an invalid version-3 invocation");
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
