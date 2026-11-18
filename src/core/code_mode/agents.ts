import { resolve } from "node:path";
import { z } from "zod";
import type { TauCodeModeHandler } from "../../code_mode/runtime.js";
import type { NotificationInbox } from "../agent/notification_inbox.js";
import type { SessionRuntimeSettings } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { getEffectiveAutoCompactThresholdTokens } from "../session/auto_compaction_threshold.js";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { AgentRequestError } from "../subagents/errors.js";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import {
  describeSubagentLaunchChoices,
  resolveSubagentEffectiveSettings,
} from "../subagents/registry.js";
import type {
  ResolveSubagentPrompt,
  SubagentLaunchModel,
  SubagentRuntimeConfig,
} from "../subagents/types.js";
import type { AgentJobRegistry } from "../tools/agent_jobs.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { Persona } from "../types.js";
import type { CodeModeCapability } from "./capability.js";

export type AgentsCapabilityOptions = {
  callerId: string;
  backend: ToolExecutionBackend;
  jobs: AgentJobRegistry;
  supervisor: AgentSupervisor;
  persona: Persona;
  autoCompactThresholdTokens: number | null;
  config: SessionRuntimeSettings;
  modelResolver: ModelResolver;
  subagentSystemPrompt: string | undefined;
  history: HistoryQuery;
  mcp?: McpManager;
  cwd: string;
  resolveSubagentPrompt?: ResolveSubagentPrompt;
  /** The main agent's inbox, absent when the session has notifications turned off. */
  notifications?: NotificationInbox;
};
const id = z.string().min(1).max(256);
const message = z
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

export const agentsCapabilityMetadata = {
  name: "agents",
  description:
    "Inspect allowed launch models and capacity, start delegated workers, send them queued or steering input, interrupt and wait for them, and read selected parts of their conversations. Access covers the workers you started and the workers they started. Follow the delegation policy in your instructions. Workers keep running when a program ends or is cancelled.",
};

export function createAgentsCapability(
  options: AgentsCapabilityOptions,
  originHistoryEntryId: string,
): CodeModeCapability {
  const supervisor = options.supervisor.scope(options.callerId);
  const notifiesCaller =
    options.callerId === options.supervisor.mainAgentId && options.notifications !== undefined;
  const callerSpawnOptions = notifiesCaller
    ? spawnOptions.extend({ notifyOnCompletion: z.boolean().default(true) })
    : spawnOptions.transform((input) => ({ ...input, notifyOnCompletion: false }));
  const parseAllowedLaunchModel = (model: string) => {
    const parsed = parseSubagentLaunchModel(model, { resolveModel: options.modelResolver });
    if (
      !parsed.launchModel ||
      !options.persona.subagentLaunchModels.includes(parsed.launchModel.normalized)
    )
      return { error: parsed.error ?? "Subagent launch model is not allowed" };
    return parsed;
  };
  const api: Record<string, TauCodeModeHandler> = {
    launchOptions: (args) => {
      z.tuple([]).parse(args);
      const choices = describeSubagentLaunchChoices(options.persona);
      return {
        inherited: { model: choices.inherited },
        overrides: choices.overrides.flatMap((model) => {
          const { launchModel } = parseAllowedLaunchModel(model);
          return launchModel ? [{ model: launchModel.normalized }] : [];
        }),
        capacity: supervisor.getCapacity(),
      };
    },
    spawn: async (args, context) => {
      const [prompt, input] = z.tuple([message, callerSpawnOptions]).parse(args);
      context.signal.throwIfAborted();
      const launchEpoch = supervisor.prepareSpawn();
      let launchModel: SubagentLaunchModel | undefined;
      if (input.model) {
        const parsed = parseAllowedLaunchModel(input.model);
        if (!parsed.launchModel) throw new Error(parsed.error);
        launchModel = parsed.launchModel;
      }
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
        notifyOnCompletion: input.notifyOnCompletion,
        launchEpoch,
        agents: options,
        prompt,
        title: input.title,
        originHistoryEntryId,
        personaId: options.persona.id,
      });
    },
    list: (args) => {
      z.tuple([]).parse(args);
      return {
        agents: supervisor.list(),
        capacity: supervisor.getCapacity(),
      };
    },
    read: (args) => {
      const [agentId] = z.tuple([id]).parse(args);
      return supervisor.read(agentId);
    },
    sendInput: (args, context) => {
      const [agentId, prompt, { mode }] = z
        .tuple([id, message, z.strictObject({ mode: z.enum(["queue", "steer"]) })])
        .parse(args);
      context.signal.throwIfAborted();
      return supervisor.sendInput({ id: agentId, prompt, mode });
    },
    interrupt: (args, context) => {
      const [agentId, settings] = z
        .tuple([
          id,
          z
            .strictObject({
              wait: z.boolean().optional(),
              scope: z.enum(["agent", "subtree"]).optional(),
            })
            .optional(),
        ])
        .parse(args);
      return supervisor.interrupt(
        agentId,
        context.signal,
        settings?.wait ?? true,
        settings?.scope ?? "agent",
      );
    },
    waitUntilIdle: async (args, context) => {
      const [agentId] = z.tuple([id]).parse(args);
      const [state] = await supervisor.waitForAgents([agentId], context.signal);
      return state;
    },
    readResponse: (args) => {
      const [agentId] = z.tuple([id]).parse(args);
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
    },
    trace: (args) => {
      const [agentId, filters] = z.tuple([id, traceOptions.optional()]).parse(args);
      return supervisor.getTrace(agentId).trace(filters ?? {});
    },
    readContent: (args) => {
      const [agentId, ref, settings] = z
        .tuple([
          id,
          z.string().min(1).max(256),
          z.strictObject({ cursor: z.string().max(4096).optional() }).optional(),
        ])
        .parse(args);
      return supervisor.getTrace(agentId).readContent({ ref, cursor: settings?.cursor });
    },
    readText: (args) => {
      const [agentId, seq] = z.tuple([id, z.number().int().positive()]).parse(args);
      const result = supervisor.getTrace(agentId).readText(seq, Infinity);
      if (!result.complete)
        throw new AgentRequestError("expired_content", "The full trace text is unavailable");
      return result.text;
    },
  };
  if (notifiesCaller) {
    api.setCompletionNotification = (args) => {
      const [agentId, enabled] = z.tuple([id, z.boolean()]).parse(args);
      supervisor.setCompletionNotification(agentId, enabled);
      return supervisor.read(agentId);
    };
  }
  for (const [name, handler] of Object.entries(api)) {
    api[name] = async (args, context) => {
      try {
        context.signal.throwIfAborted();
        return await handler(args, context);
      } catch (error) {
        if (error instanceof AgentRequestError) throw error;
        throw new AgentRequestError(
          context.signal.aborted
            ? "cancelled"
            : error instanceof z.ZodError
              ? "invalid_arguments"
              : "operation_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
  }
  return {
    ...agentsCapabilityMetadata,
    api,
  };
}
