import { Check, Errors } from "typebox/value";
import { z } from "zod";
import type { CommandClientToolConfig } from "../core/config/client_tools.js";
import { type CoreDeps, createDefaultCoreDeps } from "../core/runtime/deps.js";
import { DEFAULT_COMMAND_CAPTURE_BYTES } from "../core/tools/execution_backend.js";
import { sanitizeEnvironment } from "../core/utils/sanitize_env.js";
import type { TauSdkClientTool } from "../sdk/types.js";

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const COMMAND_KILL_GRACE_MS = 2_000;

const commandClientToolResultSchema = z
  .object({
    content: z.string(),
  })
  .strict();

type CommandClientToolDeps = Pick<CoreDeps, "env" | "spawn">;

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
      const result = await deps.spawn(config.command, config.args ?? [], {
        cwd: deps.env.cwd(),
        env: {
          ...sanitizeEnvironment(deps.env.env()),
          ...(config.env ?? {}),
        },
        detached: true,
        signal: context.signal,
        timeoutMs,
        maxCaptureBytes: DEFAULT_COMMAND_CAPTURE_BYTES,
        maxCaptureMode: "terminate",
        maxCaptureStrategy: "head",
        captureOutput: "split",
        killGraceMs: COMMAND_KILL_GRACE_MS,
        killProcessGroup: true,
        stdio: ["pipe", "pipe", "pipe"],
        input: `${JSON.stringify({
          version: 1,
          sessionId: context.sessionId,
          callId: context.callId,
          arguments: args,
        })}\n`,
      });

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

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          `Command client tool '${config.name}' returned invalid JSON; expected {"content":"..."}.`,
        );
      }

      const parsed = commandClientToolResultSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(
          `Command client tool '${config.name}' returned an invalid result; expected exactly {"content":"..."}.`,
        );
      }

      return parsed.data;
    },
  }));
}
