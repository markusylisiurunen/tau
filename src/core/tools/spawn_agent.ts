import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import { getSubagentDescription, resolveSubagentEffectiveSettings } from "../subagents/registry.js";
import type { SubagentLaunchModel, SubagentRuntimeConfig } from "../subagents/types.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText } from "./subagent_ui.js";
import { TOOL_NAME_SPAWN_AGENT } from "./tool_names.js";

const SPAWN_AGENT_DESCRIPTION = [
  "Launch a background subagent and return its id.",
  "Use wait_for_agent to retrieve outputs when it finishes.",
  "The prompt must be self-contained because subagents cannot ask follow-up questions.",
].join(" ");

const SPAWN_AGENT_NAME_DESCRIPTION = [
  "Subagent name to run.",
  "Must match a subagent enabled for the current persona.",
].join(" ");

const SPAWN_AGENT_TITLE_DESCRIPTION = [
  "Short UI title shown while the subagent runs.",
  "Avoid title case; use lower-case except for proper nouns.",
].join(" ");

const SPAWN_AGENT_PROMPT_DESCRIPTION = [
  "Prompt to send to the subagent.",
  "This is the only input the subagent receives, so include all context, file paths, and expectations.",
].join(" ");

const SPAWN_AGENT_MODEL_DESCRIPTION = [
  "Optional launch override in format <provider>/<model>:<effort>.",
  "The value must match one of the selected subagent's configured launch models.",
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
    },
    { additionalProperties: false },
  ),
};

const spawnArgsSchema = z.object({
  name: z.string().trim().catch(""),
  title: z.string().trim().catch(""),
  prompt: z.string().trim().catch(""),
  model: z.string().trim().optional().catch(undefined),
});

function parseSpawnArgs(raw: unknown): {
  name: string;
  title: string;
  prompt: string;
  model?: string;
} {
  const parsed = spawnArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { name: "", title: "", prompt: "", model: undefined };
}

function formatSpawnToolResult(args: { id: string; name: string; title: string }): string {
  return [`id: ${args.id}`, `name: ${args.name}`, `title: ${args.title}`, "status: running"].join(
    "\n",
  );
}

function formatAllowedLaunchModels(launchModels: string[]): string {
  if (launchModels.length === 0) {
    return "(none configured)";
  }

  return launchModels.map((entry) => `'${entry}'`).join(", ");
}

export function createSpawnAgentToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: SPAWN_AGENT_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { name, title, prompt, model } = parseSpawnArgs(toolCall.arguments);
      const headerTarget = title || "(subagent)";

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
        return { kind: "single", toolResult, uiEvent } satisfies ToolDispatchResult;
      };

      if (!name || !title || !prompt) {
        const missing = [
          !name ? "name" : undefined,
          !title ? "title" : undefined,
          !prompt ? "prompt" : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return blocked(`missing required parameter(s): ${missing}.`, {
          title: title || "(subagent)",
        });
      }

      if (!context?.persona?.subagents || Object.keys(context.persona.subagents).length === 0) {
        return blocked("spawn_agent tool is not enabled for the current persona.", {
          name,
          title,
        });
      }

      const persona = context?.persona;
      if (!persona) {
        return blocked("spawn_agent tool is not enabled for the current persona.", {
          name,
          title,
        });
      }

      const personaConfig = persona.subagents?.[name];
      if (!personaConfig) {
        return blocked(`subagent '${name}' is not enabled for the current persona.`, {
          name,
          title,
        });
      }

      const systemPrompt = context.subagentPrompts?.[name];
      if (!systemPrompt) {
        return blocked(`subagent '${name}' is missing its system prompt.`, {
          name,
          title,
        });
      }

      let launchModelOverride: SubagentLaunchModel | undefined;
      if (model !== undefined && !model) {
        return blocked(
          "model parameter must be a non-empty string in format <provider>/<model>:<effort>.",
          {
            name,
            title,
          },
        );
      }
      if (model) {
        const parsedLaunchModel = parseSubagentLaunchModel(model);
        if (parsedLaunchModel.error || !parsedLaunchModel.launchModel) {
          return blocked(`invalid model parameter: ${parsedLaunchModel.error}.`, {
            name,
            title,
          });
        }

        const launchModels = personaConfig.launchModels ?? [];
        if (launchModels.length === 0) {
          return blocked(
            `subagent '${name}' does not allow launch model overrides. allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
            {
              name,
              title,
            },
          );
        }

        if (!launchModels.includes(parsedLaunchModel.launchModel.normalized)) {
          return blocked(
            `model '${parsedLaunchModel.launchModel.normalized}' is not allowed for subagent '${name}'. allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
            {
              name,
              title,
            },
          );
        }

        launchModelOverride = parsedLaunchModel.launchModel;
      }

      const effectiveSettings = resolveSubagentEffectiveSettings({
        persona,
        config: personaConfig,
        riskLevel: context.riskLevel ?? "read-only",
        launchModel: launchModelOverride,
      });
      const runtimeConfig: SubagentRuntimeConfig = {
        name,
        systemPrompt,
        description: getSubagentDescription(name, personaConfig),
        ...effectiveSettings,
      };

      const controlPlane = context.subagentControlPlane;
      if (!controlPlane) {
        return blocked("subagent control plane is not available.", {
          name,
          title,
        });
      }

      const modelLabel =
        effectiveSettings.model !== persona.model
          ? `${effectiveSettings.model.provider}/${effectiveSettings.model.id}:${effectiveSettings.settings?.reasoning ?? "none"}`
          : undefined;

      return {
        kind: "phased",
        startedUiEvent: {
          type: "spawn_agent_started",
          toolCallId: toolCall.id,
          name,
          title,
          headerTarget,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          if (signal?.aborted) {
            const toolResult = createToolError(toolCall, "spawn_agent aborted");
            const uiEvent: ToolUiEvent = {
              type: "spawn_agent_finished",
              toolCallId: toolCall.id,
              name,
              title,
              headerTarget,
              status: "error",
              message: "aborted",
            };
            return { kind: "single", toolResult, uiEvent };
          }

          const spawnResult = controlPlane.spawn({
            runtimeConfig,
            prompt,
            title,
            modelLabel,
            config: context.config ?? {},
            authPath: context.authPath,
            backend,
            personaId: context.persona?.id,
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
            return { kind: "single", toolResult, uiEvent };
          }

          const resultText = formatSpawnToolResult({
            id: spawnResult.id,
            name,
            title,
          });

          const statusParts = [name, modelLabel, spawnResult.id].filter(Boolean);
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
          return { kind: "single", toolResult, uiEvent };
        })(),
      };
    },
  };
}
