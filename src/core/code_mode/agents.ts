import { resolve } from "node:path";
import { z } from "zod";
import {
  type AgentCapabilities,
  type Availability,
  requireCapability,
} from "../agent/capabilities.js";
import type { SessionRuntimeSettings } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { getEffectiveAutoCompactThresholdTokens } from "../session/auto_compaction_threshold.js";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { opusPreset } from "../subagents/claude_code_models.js";
import { AgentRequestError } from "../subagents/errors.js";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import {
  describeSubagentLaunchChoices,
  resolveSubagentEffectiveSettings,
} from "../subagents/registry.js";
import type { ResolveSubagentPrompt, SubagentRuntimeConfig } from "../subagents/types.js";
import type { AgentJobRegistry } from "../tools/agent_jobs.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { Persona } from "../types.js";
import { type CodeModeMethod, type CodeModePackage, definePackage, method } from "./package.js";

export type AgentsPackageOptions = {
  callerId: string;
  backend: ToolExecutionBackend;
  jobs: AgentJobRegistry;
  supervisor: AgentSupervisor;
  persona: Persona;
  autoCompactThresholdTokens: number | null;
  config: SessionRuntimeSettings;
  modelResolver: ModelResolver;
  subagentSystemPrompt: string;
  history: HistoryQuery;
  mcp: McpManager;
  cwd: string;
  resolveSubagentPrompt?: ResolveSubagentPrompt;
};
const id = z.string().min(1).max(256);
const workerMessage = z
  .string()
  .trim()
  .min(1)
  .max(256 * 1024);
const spawnOptions = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[^\r\n]+$/),
  model: z.string().min(1).optional(),
  workingDirectory: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .optional(),
  notifyOnCompletion: z.boolean().optional(),
});
const traceOptions = z.strictObject({
  kinds: z
    .array(z.enum(["input", "assistant", "tool_call", "tool_result", "notice", "status"]))
    .max(6)
    .optional(),
  toolName: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(4096).optional(),
});

export const agentsPackageDescription =
  "Start, steer, and wait for worker agents, and read what they did.";

const AGENTS_FUNCTIONS = [
  "launchOptions",
  "spawn",
  "list",
  "read",
  "sendInput",
  "interrupt",
  "waitUntilIdle",
  "readResponse",
  "trace",
  "readContent",
  "readText",
  "setCompletionNotification",
] as const;
type AgentsMethods = Record<(typeof AGENTS_FUNCTIONS)[number], CodeModeMethod>;
const DELEGATION = "Starting and managing subagents";
const COMPLETION_NOTIFICATIONS = "Completion notifications";

/** `@tau/agents` for an agent without delegation: the same exports, each failing with the reason. */
export function createUnavailableAgentsPackage(delegation: Availability): CodeModePackage {
  const methods = Object.fromEntries(
    AGENTS_FUNCTIONS.map((name) => [
      name,
      method(z.tuple([]).rest(z.unknown()), () => requireCapability(delegation, DELEGATION)),
    ]),
  ) as AgentsMethods;
  return definePackage("agents", agentsPackageDescription, methods);
}

export function createAgentsPackage(
  options: AgentsPackageOptions,
  capabilities: AgentCapabilities,
  originHistoryEntryId: string,
): CodeModePackage {
  const supervisor = options.supervisor.scope(options.callerId);
  const notifications = capabilities.completionNotifications;
  const message = opusPreset(options.persona)
    ? z
        .string()
        .max(256 * 1024)
        .regex(/\S/)
    : workerMessage;
  const parseAllowedLaunchModel = (model: string) => {
    const { launchModel, error } = parseSubagentLaunchModel(model, {
      resolveModel: options.modelResolver,
    });
    if (!launchModel || !options.persona.subagentLaunchModels.includes(launchModel.normalized))
      throw new AgentRequestError(
        "operation_failed",
        error ?? "Subagent launch model is not allowed",
      );
    return launchModel;
  };
  const methods: AgentsMethods = {
    launchOptions: method(z.tuple([]), () => {
      const choices = describeSubagentLaunchChoices(options.persona);
      return {
        inherited: { model: choices.inherited },
        overrides: choices.overrides.flatMap((model) => {
          try {
            return [{ model: parseAllowedLaunchModel(model).normalized }];
          } catch {
            return [];
          }
        }),
        capacity: supervisor.getCapacity(),
      };
    }),
    spawn: method(z.tuple([message, spawnOptions]), async ([prompt, input], context) => {
      if (input.notifyOnCompletion) requireCapability(notifications, COMPLETION_NOTIFICATIONS);
      const launchEpoch = supervisor.prepareSpawn();
      const launchModel = input.model ? parseAllowedLaunchModel(input.model) : undefined;
      const settings = resolveSubagentEffectiveSettings({
        persona: options.persona,
        launchModel,
      });
      const cwd = resolve(options.cwd, input.workingDirectory ?? ".");
      let runtimeConfig: SubagentRuntimeConfig;
      if (settings.kind === "claude-code") runtimeConfig = { ...settings, workingDirectory: cwd };
      else {
        const systemPrompt =
          cwd === resolve(options.cwd)
            ? options.subagentSystemPrompt
            : await options.resolveSubagentPrompt?.({ cwd, persona: options.persona });
        if (!systemPrompt)
          throw new Error("Subagent working-directory instructions are unavailable");
        runtimeConfig = {
          ...settings,
          workingDirectory: cwd,
          systemPrompt,
          autoCompactThresholdTokens: getEffectiveAutoCompactThresholdTokens(
            settings.model.contextWindow,
            launchModel
              ? (options.persona.subagentAutoCompactThresholdTokens?.[
                  `${settings.model.provider}/${settings.model.id}`
                ] ?? null)
              : options.autoCompactThresholdTokens,
          ),
        };
      }
      context.signal.throwIfAborted();
      return supervisor.spawn({
        ...options,
        runtimeConfig,
        notifyOnCompletion: input.notifyOnCompletion ?? notifications.available,
        launchEpoch,
        agents: options,
        prompt,
        title: input.title,
        originHistoryEntryId,
        personaId: options.persona.id,
      });
    }),
    list: method(z.tuple([]), () => ({
      agents: supervisor.list(),
      capacity: supervisor.getCapacity(),
    })),
    read: method(z.tuple([id]), ([agentId]) => supervisor.read(agentId)),
    sendInput: method(
      z.tuple([id, message, z.strictObject({ mode: z.enum(["queue", "steer"]) })]),
      ([agentId, prompt, { mode }]) => supervisor.sendInput({ id: agentId, prompt, mode }),
    ),
    interrupt: method(
      z.tuple([
        id,
        z
          .strictObject({
            wait: z.boolean().optional(),
            scope: z.enum(["agent", "subtree"]).optional(),
          })
          .optional(),
      ]),
      ([agentId, settings], { signal }) =>
        supervisor.interrupt(agentId, signal, settings?.wait ?? true, settings?.scope ?? "agent"),
    ),
    waitUntilIdle: method(z.tuple([id]), async ([agentId], { signal }) => {
      const [state] = await supervisor.waitForAgents([agentId], signal);
      return state;
    }),
    readResponse: method(z.tuple([id]), ([agentId]) => {
      const state = supervisor.read(agentId);
      if (state.status !== "idle" || state.reason !== "completed") {
        throw new AgentRequestError(
          "operation_failed",
          "The latest worker turn did not complete normally",
        );
      }
      const response = supervisor.getLastResponse(agentId);
      if (!response?.complete)
        throw new AgentRequestError("expired_content", "No complete worker response is available");
      return response.text;
    }),
    trace: method(z.tuple([id, traceOptions.optional()]), ([agentId, filters]) =>
      supervisor.getTrace(agentId).trace(filters ?? {}),
    ),
    readContent: method(
      z.tuple([
        id,
        z.string().min(1).max(256),
        z.strictObject({ cursor: z.string().max(4096).optional() }).optional(),
      ]),
      ([agentId, ref, settings]) =>
        supervisor.getTrace(agentId).readContent({ ref, cursor: settings?.cursor }),
    ),
    readText: method(z.tuple([id, z.number().int().positive()]), ([agentId, seq]) => {
      const result = supervisor.getTrace(agentId).readText(seq, Infinity);
      if (!result.complete)
        throw new AgentRequestError("expired_content", "The full trace text is unavailable");
      return result.text;
    }),
    setCompletionNotification: method(z.tuple([id, z.boolean()]), ([agentId, enabled]) => {
      requireCapability(notifications, COMPLETION_NOTIFICATIONS);
      supervisor.setCompletionNotification(agentId, enabled);
      return supervisor.read(agentId);
    }),
  };
  return definePackage("agents", agentsPackageDescription, methods);
}
