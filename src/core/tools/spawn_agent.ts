import { resolve } from "node:path";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { ModelResolver } from "../models/catalog.js";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatSpawnAgentResult } from "../subagents/format.js";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import { getSubagentDescription, resolveSubagentEffectiveSettings } from "../subagents/registry.js";
import type { SubagentLaunchModel, SubagentRuntimeConfig } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { formatCwd } from "../utils/format.js";
import { parseToolArgs } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { buildSubagentPresentation } from "./subagent_ui.js";
import { TOOL_NAME_SPAWN_AGENT } from "./tool_names.js";

const SPAWN_AGENT_DESCRIPTION = [
  "Spawn a subagent to run in the background and return its id.",
  "Use wait_for_agents to read its latest response once it finishes.",
  "See your system instructions for available subagents and their capabilities.",
].join(" ");

const SPAWN_AGENT_NAME_DESCRIPTION = [
  "Subagent name to run.",
  "Available subagents depend on the current persona configuration.",
].join(" ");

const SPAWN_AGENT_TITLE_DESCRIPTION = [
  "A short single-line human-friendly UI title shown while the subagent runs.",
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
  "Optional single-line working directory for the subagent.",
  "When set, subagent runs as if it was started in this directory.",
].join(" ");

export const SPAWN_AGENT_TOOL: Tool = {
  name: TOOL_NAME_SPAWN_AGENT,
  description: SPAWN_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      name: Type.String({ description: SPAWN_AGENT_NAME_DESCRIPTION }),
      title: Type.String({
        description: SPAWN_AGENT_TITLE_DESCRIPTION,
        pattern: "^[^\\r\\n]+$",
      }),
      prompt: Type.String({ description: SPAWN_AGENT_PROMPT_DESCRIPTION }),
      model: Type.Optional(Type.String({ description: SPAWN_AGENT_MODEL_DESCRIPTION })),
      workingDirectory: Type.Optional(
        Type.String({
          description: SPAWN_AGENT_WORKING_DIRECTORY_DESCRIPTION,
          pattern: "^[^\\r\\n]+$",
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

const spawnArgsSchema = z
  .object({
    name: z.string().trim().min(1),
    title: z
      .string()
      .trim()
      .min(1)
      .refine((title) => !/[\r\n]/.test(title), "Title must be a single line."),
    prompt: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    workingDirectory: z
      .string()
      .trim()
      .min(1)
      .refine((path) => !/[\r\n]/.test(path), "Working directory must be a single line.")
      .optional(),
  })
  .strict();

function formatAllowedLaunchModels(launchModels: string[]): string {
  if (launchModels.length === 0) {
    return "(None configured)";
  }

  return launchModels.map((entry) => `'${entry}'`).join(", ");
}

function getSpawnAgentSubject(raw: unknown): string {
  const parsedArgs = parseToolArgs(spawnArgsSchema, raw);
  return parsedArgs.ok ? parsedArgs.data.title : "(invalid arguments)";
}

function getSpawnAgentWorkingDirectory(raw: unknown, baseCwd: string): string {
  const parsedArgs = parseToolArgs(spawnArgsSchema, raw);
  const workingDirectory = parsedArgs.ok ? parsedArgs.data.workingDirectory : undefined;
  return workingDirectory ? resolve(baseCwd, workingDirectory) : baseCwd;
}

export type ResolvedSubagentRuntime = {
  persona: Persona;
  config: Config;
  modelResolver: ModelResolver;
  subagentPrompts: Record<string, string>;
};

export type ResolveSubagentRuntime = (options: {
  cwd: string;
  persona: Persona;
}) => Promise<ResolvedSubagentRuntime>;

export function createSpawnAgentToolDefinition(options: {
  backend: ToolExecutionBackend;
  supervisor: AgentSupervisor;
  persona: Persona;
  config: Config;
  modelResolver: ModelResolver;
  subagentPrompts: Record<string, string>;
  history: HistoryQuery;
  cwd: string;
  resolveSubagentRuntime?: ResolveSubagentRuntime;
}): AgentTool {
  const { backend, supervisor } = options;
  return {
    schema: SPAWN_AGENT_TOOL,
    describe: (toolCall) => {
      const subject = getSpawnAgentSubject(toolCall.arguments);
      const workingDirectory = getSpawnAgentWorkingDirectory(toolCall.arguments, options.cwd);
      return {
        presentation: buildToolRunPresentation({
          toolName: TOOL_NAME_SPAWN_AGENT,
          subject,
          metadata: [formatCwd(workingDirectory)],
        }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      let name = "";
      let title = "";
      const subject = getSpawnAgentSubject(toolCall.arguments);
      const presentationWorkingDirectory = formatCwd(
        getSpawnAgentWorkingDirectory(toolCall.arguments, options.cwd),
      );

      const blocked = (reason: string, details?: { title?: string }) => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "tool_call_blocked",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_SPAWN_AGENT,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_SPAWN_AGENT,
            subject: details?.title ?? subject,
            details: [{ text: reason }],
            metadata: [presentationWorkingDirectory],
          }),
          reason,
        };
        return {
          content: outcome.content,
          outcome: outcome.outcome,
          uiEvent,
        } satisfies ToolImplementationOutcome;
      };

      const parsedArgs = parseToolArgs(spawnArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      const { prompt, model, workingDirectory } = parsedArgs.data;
      name = parsedArgs.data.name;
      title = parsedArgs.data.title;

      const { persona, cwd: baseCwd, subagentPrompts } = options;

      const cwd = workingDirectory ? resolve(baseCwd, workingDirectory) : baseCwd;
      let effectivePersona = persona;
      let config = options.config;
      let modelResolver = options.modelResolver;
      let effectiveSubagentPrompts = subagentPrompts;
      if (workingDirectory) {
        if (!options.resolveSubagentRuntime) {
          return executeTool(context, () =>
            blocked("Working-directory context resolution is unavailable.", { title }),
          );
        }
        try {
          const runtime = await options.resolveSubagentRuntime({ cwd, persona });
          effectivePersona = runtime.persona;
          config = runtime.config;
          modelResolver = runtime.modelResolver;
          effectiveSubagentPrompts = runtime.subagentPrompts;
        } catch (error) {
          return executeTool(context, () =>
            blocked(
              `Failed to build the subagent prompt for workingDirectory '${cwd}': ${(error as Error).message}`,
              {
                title,
              },
            ),
          );
        }
      }
      if (!effectivePersona.subagents || Object.keys(effectivePersona.subagents).length === 0) {
        return executeTool(context, () =>
          blocked("The spawn_agent tool is not enabled for the resolved persona.", {
            title,
          }),
        );
      }
      const personaConfig = effectivePersona.subagents[name];
      if (!personaConfig) {
        return executeTool(context, () =>
          blocked(`Subagent '${name}' is not enabled for the resolved persona.`, {
            title,
          }),
        );
      }
      const systemPrompt = effectiveSubagentPrompts[name];
      if (!systemPrompt) {
        return executeTool(context, () =>
          blocked(`Subagent '${name}' is missing its system prompt.`, {
            title,
          }),
        );
      }

      let launchModelOverride: SubagentLaunchModel | undefined;
      if (model) {
        const parsedLaunchModel = parseSubagentLaunchModel(model, { resolveModel: modelResolver });
        if (parsedLaunchModel.error || !parsedLaunchModel.launchModel) {
          return executeTool(context, () =>
            blocked(`Invalid model parameter: ${parsedLaunchModel.error}.`, {
              title,
            }),
          );
        }

        const launchModels = personaConfig.launchModels ?? [];
        if (launchModels.length === 0) {
          return executeTool(context, () =>
            blocked(
              `Subagent '${name}' does not allow launch model overrides. Allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
              {
                title,
              },
            ),
          );
        }

        if (!launchModels.includes(parsedLaunchModel.launchModel.normalized)) {
          return executeTool(
            context,
            blocked(
              `Model '${parsedLaunchModel.launchModel.normalized}' is not allowed for subagent '${name}'. Allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
              {
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

      const modelLabel = `${runtimeConfig.model.provider}/${runtimeConfig.model.id}:${runtimeConfig.settings?.reasoning ?? "none"}`;
      const statusWorkingDirectory = formatCwd(runtimeConfig.workingDirectory);
      const statusPrefixParts = [name, modelLabel, statusWorkingDirectory];

      return executeTool(
        context,
        async (): Promise<ToolImplementationOutcome> => {
          if (signal?.aborted) {
            const reason = "Aborted.";
            const outcome = createTextToolOutcome(reason, "cancelled");
            const presentation = buildToolRunPresentation({
              toolName: TOOL_NAME_SPAWN_AGENT,
              subject,
              metadata: statusPrefixParts,
            });
            const uiEvent: ToolActivity = {
              type: "tool_call_finished",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_SPAWN_AGENT,
              presentation,
              status: "error",
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }

          const spawnResult = supervisor.spawn({
            runtimeConfig,
            prompt,
            title,
            originHistoryEntryId: context.assistantMessageId,
            config,
            backend,
            history: options.history,
            personaId: effectivePersona.id,
          });

          if (!spawnResult.ok) {
            const outcome = createTextToolOutcome(spawnResult.reason, "blocked");
            const uiEvent: ToolActivity = {
              type: "tool_call_blocked",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_SPAWN_AGENT,
              presentation: buildToolRunPresentation({
                toolName: TOOL_NAME_SPAWN_AGENT,
                subject: subject,
                details: [{ text: spawnResult.reason }],
                metadata: [statusWorkingDirectory],
              }),
              reason: spawnResult.reason,
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }

          const resultText = formatSpawnAgentResult(spawnResult.state, spawnResult.capacity);
          const outcome = createTextToolOutcome(resultText, "succeeded");
          const presentation = buildSubagentPresentation({
            toolName: TOOL_NAME_SPAWN_AGENT,
            subject: subject,
            output: prompt,
            detailTruncation: { maxLines: 17, strategy: "middle" },
            metadata: [...statusPrefixParts, spawnResult.state.id],
          });
          const uiEvent: ToolActivity = {
            type: "tool_call_finished",
            toolCallId: toolCall.id,
            toolName: TOOL_NAME_SPAWN_AGENT,
            presentation,
            status: "success",
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        },
        {
          type: "tool_call_started",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_SPAWN_AGENT,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_SPAWN_AGENT,
            subject: subject,
            metadata: [statusWorkingDirectory],
          }),
        },
      );
    },
  };
}
