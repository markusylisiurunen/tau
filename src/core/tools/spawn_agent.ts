import { resolve } from "node:path";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import { getSubagentDescription, resolveSubagentEffectiveSettings } from "../subagents/registry.js";
import type { SubagentLaunchModel, SubagentRuntimeConfig } from "../subagents/types.js";
import { formatCwd } from "../utils/format.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { parseToolArgs } from "../utils/zod.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import {
  createToolDispatch,
  isMainToolDispatchContext,
  type ToolDefinition,
  type ToolDispatch,
  type ToolDispatchContext,
  type ToolDispatchResult,
  type ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText } from "./subagent_ui.js";
import { TOOL_NAME_SPAWN_AGENT } from "./tool_names.js";

const SPAWN_AGENT_DESCRIPTION = [
  "Spawn a subagent to run in the background and return its id.",
  "Use wait_for_agents to collect its final response once it finishes.",
  "See your system instructions for available subagents and their capabilities.",
].join(" ");

const SPAWN_AGENT_NAME_DESCRIPTION = [
  "Subagent name to run.",
  "Available subagents depend on the current persona configuration.",
].join(" ");

const SPAWN_AGENT_TITLE_DESCRIPTION = [
  "A short human-friendly UI title shown while the subagent runs.",
  "Do not use title case; all lower-case is preferred except for proper nouns.",
].join(" ");

const SPAWN_AGENT_PROMPT_DESCRIPTION = [
  "The prompt to send to the subagent.",
  "This is the only input the subagent will receive; it must be self-contained and specific.",
  "Include all necessary context and instructions in the prompt for the subagent to complete " +
    "the request successfully.",
].join(" ");

const SPAWN_AGENT_MODEL_DESCRIPTION = [
  "Optional launch override in format <provider>/<model>:<effort>.",
  "By default, omit this field unless the user explicitly asks to use a specific model.",
  "When provided, the value must match one of the selected subagent's configured launch models.",
].join(" ");

const SPAWN_AGENT_WORKING_DIRECTORY_DESCRIPTION = [
  "Optional working directory for the subagent.",
  "When set, subagent runs as if it was started in this directory.",
].join(" ");

export const SPAWN_AGENT_TOOL: Tool = {
  name: TOOL_NAME_SPAWN_AGENT,
  description: SPAWN_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      name: Type.String({ description: SPAWN_AGENT_NAME_DESCRIPTION }),
      title: Type.String({ description: SPAWN_AGENT_TITLE_DESCRIPTION }),
      prompt: Type.String({ description: SPAWN_AGENT_PROMPT_DESCRIPTION }),
      model: Type.Optional(Type.String({ description: SPAWN_AGENT_MODEL_DESCRIPTION })),
      workingDirectory: Type.Optional(
        Type.String({ description: SPAWN_AGENT_WORKING_DIRECTORY_DESCRIPTION }),
      ),
    },
    { additionalProperties: false },
  ),
};

const spawnArgsSchema = z.object({
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  workingDirectory: z.string().trim().min(1).optional(),
});

function formatSpawnToolResult(args: {
  id: string;
  name: string;
  title: string;
  workingDirectory?: string;
}): string {
  const lines = [`ID: ${args.id}`, `Name: ${args.name}`, `Title: ${args.title}`];
  if (args.workingDirectory) {
    lines.push(`Working directory: ${args.workingDirectory}`);
  }
  lines.push("Status: Running");
  return lines.join("\n");
}

function formatAllowedLaunchModels(launchModels: string[]): string {
  if (launchModels.length === 0) {
    return "(None configured)";
  }

  return launchModels.map((entry) => `'${entry}'`).join(", ");
}

function getSpawnAgentDisplayTarget(raw: unknown): string {
  const parsedArgs = parseToolArgs(spawnArgsSchema, raw);
  return parsedArgs.ok ? parsedArgs.data.title : "(invalid arguments)";
}

export function createSpawnAgentToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: SPAWN_AGENT_TOOL,
    getDisplayTarget: (toolCall) => getSpawnAgentDisplayTarget(toolCall.arguments),
    async dispatch(
      toolCall: ToolCall,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatch> {
      let name = "";
      let title = "";
      const headerTarget = getSpawnAgentDisplayTarget(toolCall.arguments);

      const blocked = (reason: string, details?: { name?: string; title?: string }) => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "spawn_agent_blocked",
          toolCallId: toolCall.id,
          name: details?.name ?? (name || undefined),
          title: details?.title ?? headerTarget,
          headerTarget: details?.title ?? headerTarget,
          reason,
        };
        return { toolResult, uiEvent } satisfies ToolDispatchResult;
      };

      const parsedArgs = parseToolArgs(spawnArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return createToolDispatch(() => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      const { prompt, model, workingDirectory } = parsedArgs.data;
      name = parsedArgs.data.name;
      title = parsedArgs.data.title;

      if (!isMainToolDispatchContext(context)) {
        return createToolDispatch(() =>
          blocked("The spawn_agent tool is only available in the main session.", {
            name,
            title,
          }),
        );
      }

      const { persona, cwd: baseCwd, subagentPrompts } = context;

      const cwd = workingDirectory ? resolve(baseCwd, workingDirectory) : baseCwd;
      let effectivePersona = persona;
      let config = context.config;
      let modelResolver = context.modelResolver;
      let effectiveSubagentPrompts = subagentPrompts;
      if (workingDirectory) {
        if (!context.resolveSubagentRuntime) {
          return createToolDispatch(() =>
            blocked("Working-directory context resolution is unavailable.", { name, title }),
          );
        }
        try {
          const runtime = await context.resolveSubagentRuntime({ cwd, persona });
          effectivePersona = runtime.persona;
          config = runtime.config;
          modelResolver = runtime.modelResolver;
          effectiveSubagentPrompts = runtime.subagentPrompts;
        } catch (error) {
          return createToolDispatch(() =>
            blocked(
              `Failed to build the subagent prompt for workingDirectory '${cwd}': ${(error as Error).message}`,
              {
                name,
                title,
              },
            ),
          );
        }
      }
      if (!effectivePersona.subagents || Object.keys(effectivePersona.subagents).length === 0) {
        return createToolDispatch(() =>
          blocked("The spawn_agent tool is not enabled for the resolved persona.", {
            name,
            title,
          }),
        );
      }
      const personaConfig = effectivePersona.subagents[name];
      if (!personaConfig) {
        return createToolDispatch(() =>
          blocked(`Subagent '${name}' is not enabled for the resolved persona.`, {
            name,
            title,
          }),
        );
      }
      const systemPrompt = effectiveSubagentPrompts[name];
      if (!systemPrompt) {
        return createToolDispatch(() =>
          blocked(`Subagent '${name}' is missing its system prompt.`, {
            name,
            title,
          }),
        );
      }

      let launchModelOverride: SubagentLaunchModel | undefined;
      if (model) {
        const parsedLaunchModel = parseSubagentLaunchModel(model, { resolveModel: modelResolver });
        if (parsedLaunchModel.error || !parsedLaunchModel.launchModel) {
          return createToolDispatch(() =>
            blocked(`Invalid model parameter: ${parsedLaunchModel.error}.`, {
              name,
              title,
            }),
          );
        }

        const launchModels = personaConfig.launchModels ?? [];
        if (launchModels.length === 0) {
          return createToolDispatch(() =>
            blocked(
              `Subagent '${name}' does not allow launch model overrides. Allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
              {
                name,
                title,
              },
            ),
          );
        }

        if (!launchModels.includes(parsedLaunchModel.launchModel.normalized)) {
          return createToolDispatch(
            blocked(
              `Model '${parsedLaunchModel.launchModel.normalized}' is not allowed for subagent '${name}'. Allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
              {
                name,
                title,
              },
            ),
          );
        }

        launchModelOverride = parsedLaunchModel.launchModel;
      }

      const effectiveSettings = resolveSubagentEffectiveSettings({
        persona: effectivePersona,
        config: personaConfig,
        launchModel: launchModelOverride,
      });
      const runtimeConfig: SubagentRuntimeConfig = {
        name,
        systemPrompt,
        description: getSubagentDescription(name, personaConfig),
        workingDirectory: cwd,
        ...effectiveSettings,
      };

      const controlPlane = context.subagentControlPlane;

      const modelLabel = launchModelOverride?.normalized;
      const statusWorkingDirectory = runtimeConfig.workingDirectory
        ? formatCwd(runtimeConfig.workingDirectory)
        : undefined;
      const statusPrefixParts = [name, modelLabel, statusWorkingDirectory].filter(Boolean);

      return {
        startedUiEvent: {
          type: "spawn_agent_started",
          toolCallId: toolCall.id,
          name,
          title,
          headerTarget,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          if (signal?.aborted) {
            const reason = "Aborted.";
            const toolResult = createToolError(toolCall, reason);
            const uiText = buildSubagentUiText({
              output: reason,
              statusText: [...statusPrefixParts, reason].join(" · "),
              maxOutputLines: 16,
              fullText: reason,
            });
            const uiEvent: ToolUiEvent = {
              type: "spawn_agent_finished",
              toolCallId: toolCall.id,
              name,
              title,
              headerTarget,
              status: "error",
              message: reason,
              uiText,
            };
            return { toolResult, uiEvent };
          }

          const spawnResult = controlPlane.spawn({
            runtimeConfig,
            prompt,
            title,
            modelLabel,
            originHistoryEntryId: context.originHistoryEntryId,
            config,
            modelResolver,
            authPath: context.authPath,
            backend,
            personaId: effectivePersona.id,
          });

          if (!spawnResult.ok) {
            const toolResult = createToolError(toolCall, spawnResult.reason);
            const uiEvent: ToolUiEvent = {
              type: "spawn_agent_blocked",
              toolCallId: toolCall.id,
              name,
              title,
              headerTarget,
              reason: spawnResult.reason,
            };
            return { toolResult, uiEvent };
          }

          const resultText = formatSpawnToolResult({
            id: spawnResult.id,
            name,
            title,
            workingDirectory: runtimeConfig.workingDirectory,
          });

          const statusParts = [...statusPrefixParts, spawnResult.id];
          const toolResult: ToolResultMessage = createToolResult(toolCall, resultText, false);
          const uiText = buildSubagentUiText({
            output: prompt,
            statusText: statusParts.join(" · "),
            maxOutputLines: 16,
            fullText: resultText,
          });
          const uiEvent: ToolUiEvent = {
            type: "spawn_agent_finished",
            toolCallId: toolCall.id,
            name,
            title,
            headerTarget,
            status: "success",
            agentId: spawnResult.id,
            uiText,
          };
          return { toolResult, uiEvent };
        })(),
      };
    },
  };
}
