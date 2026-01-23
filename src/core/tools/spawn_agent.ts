import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { getSubagentDefinitionFromString } from "../subagents/registry.js";
import type { SubagentPersonaConfig, SubagentRuntimeDefinition } from "../subagents/types.js";
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

const SPAWN_AGENT_DESCRIPTION = [
  "Spawn a subagent to run in the background and return its id.",
  "Use wait_for_agent to collect outputs once it finishes.",
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

export const SPAWN_AGENT_TOOL: Tool = {
  name: "spawn_agent",
  description: SPAWN_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      name: Type.String({ description: SPAWN_AGENT_NAME_DESCRIPTION }),
      title: Type.String({ description: SPAWN_AGENT_TITLE_DESCRIPTION }),
      prompt: Type.String({ description: SPAWN_AGENT_PROMPT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const spawnArgsSchema = z.object({
  name: z.string().trim().catch(""),
  title: z.string().trim().catch(""),
  prompt: z.string().trim().catch(""),
});

function parseSpawnArgs(raw: unknown): { name: string; title: string; prompt: string } {
  const parsed = spawnArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { name: "", title: "", prompt: "" };
}

function getEnabledSubagentConfig(
  context: ToolDispatchContext | undefined,
  definition: SubagentRuntimeDefinition,
): SubagentPersonaConfig | undefined {
  const persona = context?.persona;
  const config = persona?.subagents;
  return config?.[definition.name];
}

function formatSpawnToolResult(args: { id: string; name: string; title: string }): string {
  return [`id: ${args.id}`, `name: ${args.name}`, `title: ${args.title}`, "status: running"].join(
    "\n",
  );
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
      const { name, title, prompt } = parseSpawnArgs(toolCall.arguments);

      const blocked = (reason: string, details?: { name?: string; title?: string }) => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "spawn_agent_blocked",
          toolCallId: toolCall.id,
          name: details?.name ?? (name || undefined),
          title: details?.title ?? (title || "(subagent)"),
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

      const definition = getSubagentDefinitionFromString(name);
      if (!definition) {
        return blocked(`unknown subagent '${name}'.`, {
          name,
          title,
        });
      }

      const personaConfig = getEnabledSubagentConfig(context, definition);
      if (!personaConfig) {
        return blocked(`subagent '${definition.name}' is not enabled for the current persona.`, {
          name: definition.name,
          title,
        });
      }

      const controlPlane = context.subagentControlPlane;
      if (!controlPlane) {
        return blocked("subagent control plane is not available.", {
          name: definition.name,
          title,
        });
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "spawn_agent_started",
          toolCallId: toolCall.id,
          name: definition.name,
          title,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          if (signal?.aborted) {
            const toolResult = createToolError(toolCall, "spawn_agent aborted");
            const uiEvent: ToolUiEvent = {
              type: "spawn_agent_finished",
              toolCallId: toolCall.id,
              name: definition.name,
              title,
              status: "error",
              message: "aborted",
            };
            return { kind: "single", toolResult, uiEvent };
          }

          const spawnResult = controlPlane.spawn({
            definition,
            personaConfig,
            prompt,
            title,
            config: context.config ?? {},
            authPath: context.authPath,
            backend,
          });

          if (!spawnResult.ok) {
            const toolResult = createToolError(toolCall, spawnResult.reason);
            const uiEvent: ToolUiEvent = {
              type: "spawn_agent_blocked",
              toolCallId: toolCall.id,
              name: definition.name,
              title,
              reason: spawnResult.reason,
            };
            return { kind: "single", toolResult, uiEvent };
          }

          const resultText = formatSpawnToolResult({
            id: spawnResult.id,
            name: definition.name,
            title,
          });

          const toolResult: ToolResultMessage = createToolResult(toolCall, resultText, false);
          const uiText = buildSubagentUiText({
            output: prompt,
            statusText: `${definition.name} · ${spawnResult.id}`,
            maxOutputLines: 16,
          });
          const uiEvent: ToolUiEvent = {
            type: "spawn_agent_finished",
            toolCallId: toolCall.id,
            name: definition.name,
            title,
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
