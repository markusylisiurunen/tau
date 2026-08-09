import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Check, Errors } from "typebox/value";
import type { CommandClientToolConfig } from "../core/config/client_tools.js";
import { type CoreDeps, createDefaultCoreDeps } from "../core/runtime/deps.js";
import { DEFAULT_COMMAND_CAPTURE_BYTES } from "../core/tools/execution_backend.js";
import {
  createTauClientToolCommandExecResponse,
  createTauClientToolCommandInvoke,
  parseTauClientToolCommandOutput,
  type TauClientToolCommandOutput,
} from "../sdk/client_tool_command.js";
import type { TauSdkClientTool, TauSdkClientToolContext } from "../sdk/types.js";

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const COMMAND_KILL_GRACE_MS = 2_000;
const MAX_ACTIVE_EXECUTIONS = 8;
const MAX_PROTOCOL_FRAME_BYTES = DEFAULT_COMMAND_CAPTURE_BYTES;

type CommandClientToolDeps = Pick<CoreDeps, "spawn">;

export function createCommandClientTools(
  configs: CommandClientToolConfig[],
  deps: CommandClientToolDeps = createDefaultCoreDeps(),
): TauSdkClientTool[] {
  return configs.map((config) => ({
    schema: {
      name: config.name,
      description: config.description,
      parameters: config.parameters,
      ...(config.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: config.executionTimeoutMs }),
    },
    execute: async (args, context) => {
      if (!Check(config.parameters, args)) {
        const issue = Errors(config.parameters, args)[0];
        const detail = issue
          ? `${issue.instancePath || "arguments"} ${issue.message}`
          : "arguments are invalid";
        throw new Error(`Invalid arguments for command client tool '${config.name}': ${detail}.`);
      }

      const timeoutMs = config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      const protocolController = new AbortController();
      const signal = AbortSignal.any([context.signal, protocolController.signal]);
      const activeExecutions = new Map<string, AbortController>();
      const executionTasks = new Set<Promise<void>>();
      const seenRequestIds = new Set<string>();
      const decoder = new StringDecoder("utf8");
      let stdoutBuffer = "";
      let observedStdout = false;
      let finalContent: string | undefined;
      let protocolError: Error | undefined;
      let writeQueue = Promise.resolve();
      let writeToCommand: ((frame: unknown) => Promise<void>) | undefined;

      const failProtocol = (error: Error): void => {
        if (protocolError) return;
        protocolError = error;
        for (const controller of activeExecutions.values()) controller.abort(error);
        protocolController.abort(error);
      };
      const handleFrame = (frame: TauClientToolCommandOutput): void => {
        if (finalContent !== undefined) {
          failProtocol(
            new Error(`Command client tool '${config.name}' wrote data after its result.`),
          );
          return;
        }
        if (frame.type === "result") {
          finalContent = frame.content;
          return;
        }
        if (frame.type === "exec.cancel") {
          activeExecutions.get(frame.requestId)?.abort();
          return;
        }
        if (seenRequestIds.has(frame.requestId)) {
          failProtocol(
            new Error(
              `Command client tool '${config.name}' reused execution request id '${frame.requestId}'.`,
            ),
          );
          return;
        }
        if (activeExecutions.size >= MAX_ACTIVE_EXECUTIONS) {
          failProtocol(
            new Error(
              `Command client tool '${config.name}' exceeded the ${MAX_ACTIVE_EXECUTIONS}-execution concurrency limit.`,
            ),
          );
          return;
        }
        seenRequestIds.add(frame.requestId);
        const executionController = new AbortController();
        activeExecutions.set(frame.requestId, executionController);
        const task = executeCommandRequest(frame, context, executionController.signal)
          .then(
            (result) =>
              createTauClientToolCommandExecResponse({
                requestId: frame.requestId,
                result,
              }),
            (error) =>
              createTauClientToolCommandExecResponse({
                requestId: frame.requestId,
                error: error instanceof Error ? error.message : String(error),
              }),
          )
          .then(async (response) => {
            if (!protocolController.signal.aborted) {
              await writeToCommand?.(response);
            }
          })
          .catch((error) => failProtocol(error instanceof Error ? error : new Error(String(error))))
          .finally(() => {
            if (activeExecutions.get(frame.requestId) === executionController) {
              activeExecutions.delete(frame.requestId);
            }
          });
        executionTasks.add(task);
        void task.finally(() => executionTasks.delete(task));
      };
      const consumeStdout = (text: string): void => {
        if (protocolError || !text) return;
        stdoutBuffer += text;
        while (true) {
          const newlineIndex = stdoutBuffer.indexOf("\n");
          if (newlineIndex === -1) break;
          const rawLine = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (Buffer.byteLength(rawLine, "utf8") > MAX_PROTOCOL_FRAME_BYTES) {
            stdoutBuffer = "";
            failProtocol(
              new Error(
                `Command client tool '${config.name}' exceeded the ${MAX_PROTOCOL_FRAME_BYTES}-byte protocol frame limit.`,
              ),
            );
            return;
          }
          const line = rawLine.trim();
          if (!line) continue;
          try {
            handleFrame(parseCommandOutputLine(line));
          } catch (error) {
            failProtocol(error instanceof Error ? error : new Error(String(error)));
          }
          if (protocolError) {
            stdoutBuffer = "";
            return;
          }
        }
        if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_PROTOCOL_FRAME_BYTES) {
          stdoutBuffer = "";
          failProtocol(
            new Error(
              `Command client tool '${config.name}' exceeded the ${MAX_PROTOCOL_FRAME_BYTES}-byte protocol frame limit.`,
            ),
          );
        }
      };

      const result = await deps.spawn(config.command, config.args ?? [], {
        detached: true,
        signal,
        timeoutMs,
        maxCaptureBytes: DEFAULT_COMMAND_CAPTURE_BYTES,
        maxCaptureMode: "terminate",
        maxCaptureStrategy: "head",
        captureOutput: "split",
        killGraceMs: COMMAND_KILL_GRACE_MS,
        killProcessGroup: true,
        stdio: ["pipe", "pipe", "pipe"],
        keepStdinOpen: true,
        input: `${JSON.stringify(
          createTauClientToolCommandInvoke({
            sessionId: context.sessionId,
            callId: context.callId,
            arguments: args,
          }),
        )}\n`,
        onSpawn: (child) => {
          observedStdout = true;
          writeToCommand = (frame) => {
            const write = writeQueue.then(async () => {
              if (!child.stdin) {
                throw new Error(`Command client tool '${config.name}' closed its protocol input.`);
              }
              await writeWithBackpressure(child.stdin, `${JSON.stringify(frame)}\n`);
            });
            writeQueue = write;
            return write;
          };
          child.stdout?.on("data", (chunk) => consumeStdout(decoder.write(chunk as Buffer)));
        },
      });

      for (const controller of activeExecutions.values()) controller.abort();
      await Promise.allSettled(executionTasks);
      activeExecutions.clear();
      if (observedStdout) {
        consumeStdout(decoder.end());
      } else {
        consumeStdout(result.stdout);
      }
      if (!protocolError && stdoutBuffer.trim()) {
        if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_PROTOCOL_FRAME_BYTES) {
          failProtocol(
            new Error(
              `Command client tool '${config.name}' exceeded the ${MAX_PROTOCOL_FRAME_BYTES}-byte protocol frame limit.`,
            ),
          );
        } else {
          try {
            handleFrame(parseCommandOutputLine(stdoutBuffer.trim()));
          } catch (error) {
            failProtocol(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }

      if (protocolError) throw protocolError;
      if (result.aborted) {
        throw new Error(`Command client tool '${config.name}' was cancelled.`);
      }
      if (result.timedOut) {
        throw new Error(`Command client tool '${config.name}' timed out after ${timeoutMs}ms.`);
      }
      if (result.captureLimitExceeded) {
        throw new Error(
          `Command client tool '${config.name}' exceeded the ${DEFAULT_COMMAND_CAPTURE_BYTES}-byte output limit.`,
        );
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        const status = result.closeSignal
          ? `signal ${result.closeSignal}`
          : `exit code ${result.exitCode ?? "unknown"}`;
        throw new Error(
          `Command client tool '${config.name}' failed with ${status}${detail ? `: ${detail}` : "."}`,
        );
      }
      if (finalContent === undefined) {
        throw new Error(`Command client tool '${config.name}' returned no version-2 result frame.`);
      }

      return { content: finalContent };
    },
  }));
}

async function executeCommandRequest(
  frame: Extract<TauClientToolCommandOutput, { type: "exec" }>,
  context: TauSdkClientToolContext,
  signal: AbortSignal,
) {
  const { stdinBase64, ...options } = frame.options;
  return await context.executionEnvironment.exec(frame.command, {
    ...options,
    ...(stdinBase64 === undefined ? {} : { stdin: Buffer.from(stdinBase64, "base64") }),
    signal,
  });
}

async function writeWithBackpressure(stream: Writable, content: string): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("command client tool protocol input is closed");
  }

  await new Promise<void>((resolve, reject) => {
    let callbackComplete = false;
    let drainComplete = true;
    let settled = false;

    const cleanup = () => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      if (!error && (!callbackComplete || !drainComplete)) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => {
      drainComplete = true;
      finish();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () =>
      finish(new Error("command client tool protocol input closed during write"));

    stream.once("error", onError);
    stream.once("close", onClose);
    const accepted = stream.write(content, (error) => {
      callbackComplete = true;
      finish(error ?? undefined);
    });
    if (!accepted) {
      drainComplete = false;
      stream.once("drain", onDrain);
    }
  });
}

function parseCommandOutputLine(line: string): TauClientToolCommandOutput {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("command client tool returned invalid JSON protocol framing");
  }
  return parseTauClientToolCommandOutput(value);
}
