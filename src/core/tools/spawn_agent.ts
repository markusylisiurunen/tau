import { readFileSync } from "node:fs";
import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { loadSkillsForPromptContext } from "../config/skills_loader.js";
import { resolveRuntimePromptBootstrap } from "../runtime/runtime_bootstrap.js";
import { composeSessionPrompts } from "../runtime/session_prompt_composer.js";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import { getSubagentDescription, resolveSubagentEffectiveSettings } from "../subagents/registry.js";
import type { SubagentLaunchModel, SubagentRuntimeConfig } from "../subagents/types.js";
import type { Persona, RiskLevel } from "../types.js";
import { formatCwd } from "../utils/format.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  resolveSandboxHostRoot,
  resolveSandboxMappedWorkingDirectory,
} from "../utils/sandbox_prompt_paths.js";
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

const SPAWN_AGENT_MODEL_DESCRIPTION = [
  "Optional launch override in format <provider>/<model>:<effort>.",
  "The value must match one of the selected subagent's configured launch models.",
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
  name: z.string().trim().catch(""),
  title: z.string().trim().catch(""),
  prompt: z.string().trim().catch(""),
  model: z.string().trim().optional().catch(undefined),
  workingDirectory: z.string().trim().optional().catch(undefined),
});

function parseSpawnArgs(raw: unknown): {
  name: string;
  title: string;
  prompt: string;
  model?: string;
  workingDirectory?: string;
} {
  const parsed = spawnArgsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : { name: "", title: "", prompt: "", model: undefined, workingDirectory: undefined };
}

function formatSpawnToolResult(args: {
  id: string;
  name: string;
  title: string;
  workingDirectory?: string;
}): string {
  const lines = [`id: ${args.id}`, `name: ${args.name}`, `title: ${args.title}`];
  if (args.workingDirectory) {
    lines.push(`workingDirectory: ${args.workingDirectory}`);
  }
  lines.push("status: running");
  return lines.join("\n");
}

function formatAllowedLaunchModels(launchModels: string[]): string {
  if (launchModels.length === 0) {
    return "(none configured)";
  }

  return launchModels.map((entry) => `'${entry}'`).join(", ");
}

async function buildSubagentSystemPrompt(args: {
  name: string;
  persona: Persona;
  riskLevel: RiskLevel;
  config: ToolDispatchContext["config"];
  cwd: string;
  hostCwd: string;
  home: string;
  includeAgentContext: boolean;
  sandboxEnabled: boolean;
  sandboxHostRoot?: string;
}): Promise<string | undefined> {
  const skills = await loadSkillsForPromptContext({
    config: args.config,
    cwd: args.hostCwd,
  });
  const bootstrap = resolveRuntimePromptBootstrap({
    persona: args.persona,
    discoveredSkills: skills,
    cwd: args.hostCwd,
    home: args.home,
    includeAgentContext: args.includeAgentContext,
    sandboxEnabled: args.sandboxEnabled,
    sandboxConfig: args.config?.sandbox,
    sandboxHostRoot: args.sandboxHostRoot,
    sandboxEnvironmentInfo: args.config?.sandbox?.environmentInfo,
    readFile: (path) => readFileSync(path, "utf-8"),
  });

  const composition = composeSessionPrompts({
    persona: args.persona,
    riskLevel: args.riskLevel,
    // Sandbox path invariant: once workingDirectory is resolved, keep that exact sandbox path as
    // the model-visible cwd. Re-deriving cwd from hostCwd can collapse to mount root when host
    // cwd is outside a git repo, which breaks subagent path context.
    cwd: args.cwd,
    hostCwd: bootstrap.promptContext.hostCwd,
    datetime: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    skillsBlock: bootstrap.promptContext.skillsBlock,
    projectContextBlock: bootstrap.promptContext.projectContextBlock,
    sandboxEnabled: bootstrap.promptContext.sandboxEnabled,
    sandboxEnvironmentInfo: bootstrap.promptContext.sandboxEnvironmentInfo,
  });

  return composition.subagentPrompts[args.name];
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
      const { name, title, prompt, model, workingDirectory } = parseSpawnArgs(toolCall.arguments);
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
      if (workingDirectory !== undefined && !workingDirectory) {
        return blocked("workingDirectory parameter must be a non-empty string.", {
          name,
          title,
        });
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

      const baseCwd = context.cwd ?? process.cwd();
      const baseHostCwd = context.hostCwd ?? process.cwd();
      const baseHome = context.home ?? process.env.HOME ?? process.cwd();
      const sandboxEnabled = context.sandboxEnabled ?? false;
      const sandboxMountPath = context.config?.sandbox?.mountPath;
      const sandboxHostRoot = resolveSandboxHostRoot({
        cwd: baseCwd,
        hostCwd: baseHostCwd,
        sandboxEnabled,
        sandboxMountPath,
      });
      const {
        cwd,
        hostCwd,
        error: workingDirectoryError,
      } = resolveSandboxMappedWorkingDirectory({
        cwd: baseCwd,
        hostCwd: baseHostCwd,
        workingDirectory,
        sandboxEnabled,
        sandboxMountPath,
      });
      if (workingDirectoryError) {
        return blocked(workingDirectoryError, {
          name,
          title,
        });
      }

      let systemPrompt: string | undefined;
      if (workingDirectory) {
        try {
          systemPrompt = await buildSubagentSystemPrompt({
            name,
            persona,
            riskLevel: context.riskLevel ?? "read-only",
            config: context.config,
            cwd,
            hostCwd,
            home: baseHome,
            includeAgentContext: context.includeAgentContext !== false,
            sandboxEnabled,
            sandboxHostRoot,
          });
        } catch (error) {
          return blocked(
            `failed to build subagent prompt for workingDirectory '${cwd}': ${(error as Error).message}`,
            {
              name,
              title,
            },
          );
        }
      } else {
        systemPrompt = context.subagentPrompts?.[name];
      }
      if (!systemPrompt) {
        return blocked(`subagent '${name}' is missing its system prompt.`, {
          name,
          title,
        });
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
        workingDirectory: cwd,
        ...effectiveSettings,
      };

      const controlPlane = context.subagentControlPlane;
      if (!controlPlane) {
        return blocked("subagent control plane is not available.", {
          name,
          title,
        });
      }

      const modelLabel = launchModelOverride?.normalized;

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
            originHistoryEntryId: context.turnUserHistoryEntryId,
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
            workingDirectory: runtimeConfig.workingDirectory,
          });

          const statusWorkingDirectory = runtimeConfig.workingDirectory
            ? formatCwd(runtimeConfig.workingDirectory)
            : undefined;
          const statusParts = [name, modelLabel, statusWorkingDirectory, spawnResult.id].filter(
            Boolean,
          );
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
