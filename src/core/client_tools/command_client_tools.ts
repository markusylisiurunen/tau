import type { Writable } from "node:stream";
import { Check, Errors } from "typebox/value";
import {
  createTauClientToolCommandExecResponse,
  createTauClientToolCommandExecute,
  createTauClientToolCommandOutputDecoder,
  createTauClientToolCommandPrepare,
  type TauClientToolCommandOutput,
} from "../../sdk/client_tool_command.js";
import type { TauClientToolPresentation } from "../../sdk/client_tool_presentation.js";
import type {
  TauSdkClientTool,
  TauSdkClientToolContext,
  TauSdkClientToolDescribeContext,
  TauSdkClientToolResult,
} from "../../sdk/types.js";
import type { CommandClientToolConfig } from "../config/client_tools.js";
import { type CoreDeps, createDefaultCoreDeps } from "../runtime/deps.js";
import { DEFAULT_COMMAND_CAPTURE_BYTES } from "../tools/execution_backend.js";

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const COMMAND_KILL_GRACE_MS = 2_000;
const MAX_ACTIVE_EXECUTIONS = 8;

type CommandClientToolDeps = Pick<CoreDeps, "spawn">;

export function createCommandClientTools(
  configs: CommandClientToolConfig[],
  deps: CommandClientToolDeps = createDefaultCoreDeps(),
): TauSdkClientTool[] {
  return configs.map((config) => {
    const preparedCalls = new Map<string, PreparedCommandClientToolCall>();
    return {
      schema: {
        name: config.name,
        description: config.description,
        parameters: config.parameters,
        ...(config.executionTimeoutMs === undefined
          ? {}
          : { executionTimeoutMs: config.executionTimeoutMs }),
      },
      describe: async (args, context) => {
        validateCommandClientToolArguments(config, args);
        if (preparedCalls.has(context.callId)) {
          throw new Error(`Command client tool '${config.name}' prepared the same call twice.`);
        }

        const prepared = prepareCommandClientToolCall(config, args, context, deps);
        preparedCalls.set(context.callId, prepared);
        void prepared.settled.finally(() => {
          if (preparedCalls.get(context.callId) === prepared) {
            preparedCalls.delete(context.callId);
          }
        });
        return await prepared.presentation;
      },
      execute: async (_args, context) => {
        const prepared = preparedCalls.get(context.callId);
        if (!prepared) {
          throw new Error(`Command client tool '${config.name}' was not prepared.`);
        }
        preparedCalls.delete(context.callId);
        return await prepared.execute(context);
      },
    };
  });
}

type PreparedCommandClientToolCall = {
  presentation: Promise<TauClientToolPresentation | undefined>;
  execute(context: TauSdkClientToolContext): Promise<TauSdkClientToolResult>;
  settled: Promise<void>;
};

function validateCommandClientToolArguments(config: CommandClientToolConfig, args: unknown): void {
  if (Check(config.parameters, args)) {
    return;
  }

  const issue = Errors(config.parameters, args)[0];
  const detail = issue
    ? `${issue.instancePath || "arguments"} ${issue.message}`
    : "arguments are invalid";
  throw new Error(`Invalid arguments for command client tool '${config.name}': ${detail}.`);
}

function prepareCommandClientToolCall(
  config: CommandClientToolConfig,
  args: unknown,
  context: TauSdkClientToolDescribeContext,
  deps: CommandClientToolDeps,
): PreparedCommandClientToolCall {
  const timeoutMs = config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  const protocolController = new AbortController();
  const signal = AbortSignal.any([context.signal, protocolController.signal]);
  const activeExecutions = new Map<string, AbortController>();
  const executionTasks = new Set<Promise<void>>();
  const seenRequestIds = new Set<string>();
  const outputDecoder = createTauClientToolCommandOutputDecoder();
  let observedStdout = false;
  let ready = false;
  let executeSent = false;
  let finalResult: Extract<TauClientToolCommandOutput, { type: "result" }> | undefined;
  let protocolError: Error | undefined;
  let writeQueue = Promise.resolve();
  let writeToCommand: ((frame: unknown) => Promise<void>) | undefined;
  let executionContext: TauSdkClientToolContext | undefined;
  let resolvePresentation: (presentation: TauClientToolPresentation | undefined) => void = () => {};
  let rejectPresentation: (error: unknown) => void = () => {};
  const presentation = new Promise<TauClientToolPresentation | undefined>((resolve, reject) => {
    resolvePresentation = resolve;
    rejectPresentation = reject;
  });

  const failProtocol = (error: Error): void => {
    if (protocolError) return;
    protocolError = error;
    rejectPresentation(error);
    for (const controller of activeExecutions.values()) controller.abort(error);
    protocolController.abort(error);
  };
  const handleFrame = (frame: TauClientToolCommandOutput): void => {
    if (finalResult !== undefined) {
      failProtocol(new Error(`Command client tool '${config.name}' wrote data after its result.`));
      return;
    }
    if (frame.type === "ready") {
      if (ready) {
        failProtocol(
          new Error(`Command client tool '${config.name}' returned more than one ready frame.`),
        );
        return;
      }
      ready = true;
      resolvePresentation(frame.presentation);
      return;
    }
    if (!ready) {
      failProtocol(
        new Error(`Command client tool '${config.name}' wrote data before its ready frame.`),
      );
      return;
    }
    if (!executeSent || !executionContext) {
      failProtocol(
        new Error(
          `Command client tool '${config.name}' wrote execution data before it was accepted.`,
        ),
      );
      return;
    }
    if (frame.type === "result") {
      finalResult = frame;
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
    const task = executeCommandRequest(frame, executionContext, executionController.signal)
      .then(
        (result) => createTauClientToolCommandExecResponse({ requestId: frame.requestId, result }),
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
  const consumeStdout = (chunk?: Buffer | string): void => {
    if (protocolError) return;
    try {
      const frames = chunk === undefined ? outputDecoder.end() : outputDecoder.push(chunk);
      for (const frame of frames) handleFrame(frame);
    } catch (error) {
      failProtocol(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const processResult = deps
    .spawn(config.command, config.args ?? [], {
      detached: true,
      signal,
      timeoutMs,
      maxCaptureBytes: DEFAULT_COMMAND_CAPTURE_BYTES,
      maxCaptureMode: "terminate",
      maxCaptureStrategy: "head",
      captureOutput: "stderr",
      killGraceMs: COMMAND_KILL_GRACE_MS,
      killProcessGroup: true,
      stdio: ["pipe", "pipe", "pipe"],
      keepStdinOpen: true,
      input: `${JSON.stringify(
        createTauClientToolCommandPrepare({
          sessionId: context.sessionId,
          agentId: context.agentId,
          callId: context.callId,
          toolName: config.name,
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
        child.stdout?.on("data", (chunk) => consumeStdout(chunk as Buffer));
      },
    })
    .then(async (result) => {
      for (const controller of activeExecutions.values()) controller.abort();
      await Promise.allSettled(executionTasks);
      activeExecutions.clear();
      if (!observedStdout) consumeStdout(result.stdout);
      consumeStdout();

      if (protocolError) throw protocolError;
      if (result.aborted) {
        throw new Error(`Command client tool '${config.name}' was cancelled.`);
      }
      if (result.timedOut) {
        throw new Error(`Command client tool '${config.name}' timed out after ${timeoutMs}ms.`);
      }
      if (result.captureLimitExceeded) {
        throw new Error(
          `Command client tool '${config.name}' exceeded the ${DEFAULT_COMMAND_CAPTURE_BYTES}-byte stderr limit.`,
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
      if (!ready) {
        throw new Error(`Command client tool '${config.name}' returned no version-4 ready frame.`);
      }
      if (finalResult === undefined) {
        throw new Error(`Command client tool '${config.name}' returned no version-4 result frame.`);
      }

      return finalResult;
    });
  void processResult.catch((error) => rejectPresentation(error));

  return {
    presentation,
    execute: async (context) => {
      await presentation;
      signal.throwIfAborted();
      if (!writeToCommand) {
        throw new Error(`Command client tool '${config.name}' did not start.`);
      }
      executionContext = context;
      executeSent = true;
      await writeToCommand(createTauClientToolCommandExecute());
      const result = await processResult;
      return result.ok
        ? {
            content: result.content,
            ...(result.presentation === undefined ? {} : { presentation: result.presentation }),
          }
        : {
            ok: false,
            error: result.error,
            ...(result.presentation === undefined ? {} : { presentation: result.presentation }),
          };
    },
    settled: processResult.then(
      () => undefined,
      () => undefined,
    ),
  };
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
