import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import { parseToolArgs } from "../utils/zod.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import {
  isMainToolDispatchContext,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolDispatchResult,
  type ToolDispatchResultWithPhases,
  type ToolUiEvent,
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
  const skillsResult = await loadSkillsForPromptContext({
    config: args.config,
    cwd: args.hostCwd,
    deps: {
      fs: {
        readFile: (path) => readFileSync(path, "utf-8"),
        exists: (path) => existsSync(path),
        listDir: (path) => readdirSync(path),
        stat: (path) => statSync(path),
      },
      env: {
        getEnv: () => process.env,
        cwd: () => args.hostCwd,
        home: () => args.home,
      },
    },
  });
  if (skillsResult.errors.length > 0) {
    throw new Error(`Failed to load skills for prompt context:\n${skillsResult.errors.join("\n")}`);
  }

  const bootstrap = resolveRuntimePromptBootstrap({
    persona: args.persona,
    discoveredSkills: skillsResult.skills,
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
      riskLevel: RiskLevel,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      let name = "";
      let title = "";
      let headerTarget = "(invalid arguments)";

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

      const parsedArgs = parseToolArgs(spawnArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return blocked(`Invalid arguments: ${parsedArgs.error}`);
      }

      const { prompt, model, workingDirectory } = parsedArgs.data;
      name = parsedArgs.data.name;
      title = parsedArgs.data.title;
      headerTarget = title;

      if (!isMainToolDispatchContext(context)) {
        return blocked("The spawn_agent tool is only available in the main session.", {
          name,
          title,
        });
      }

      const {
        persona,
        config,
        cwd: baseCwd,
        hostCwd: baseHostCwd,
        home: baseHome,
        includeAgentContext,
        sandboxEnabled,
        subagentPrompts,
      } = context;

      if (!persona.subagents || Object.keys(persona.subagents).length === 0) {
        return blocked("The spawn_agent tool is not enabled for the current persona.", {
          name,
          title,
        });
      }

      const personaConfig = persona.subagents[name];
      if (!personaConfig) {
        return blocked(`Subagent '${name}' is not enabled for the current persona.`, {
          name,
          title,
        });
      }

      let launchModelOverride: SubagentLaunchModel | undefined;
      if (model) {
        const parsedLaunchModel = parseSubagentLaunchModel(model, {
          resolveModel: context.modelResolver,
        });
        if (parsedLaunchModel.error || !parsedLaunchModel.launchModel) {
          return blocked(`Invalid model parameter: ${parsedLaunchModel.error}.`, {
            name,
            title,
          });
        }

        const launchModels = personaConfig.launchModels ?? [];
        if (launchModels.length === 0) {
          return blocked(
            `Subagent '${name}' does not allow launch model overrides. Allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
            {
              name,
              title,
            },
          );
        }

        if (!launchModels.includes(parsedLaunchModel.launchModel.normalized)) {
          return blocked(
            `Model '${parsedLaunchModel.launchModel.normalized}' is not allowed for subagent '${name}'. Allowed values: ${formatAllowedLaunchModels(launchModels)}.`,
            {
              name,
              title,
            },
          );
        }

        launchModelOverride = parsedLaunchModel.launchModel;
      }

      const sandboxMountPath = config.sandbox?.mountPath;
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
            riskLevel,
            config,
            cwd,
            hostCwd,
            home: baseHome,
            includeAgentContext,
            sandboxEnabled,
            sandboxHostRoot,
          });
        } catch (error) {
          return blocked(
            `Failed to build the subagent prompt for workingDirectory '${cwd}': ${(error as Error).message}`,
            {
              name,
              title,
            },
          );
        }
      } else {
        systemPrompt = subagentPrompts[name];
      }
      if (!systemPrompt) {
        return blocked(`Subagent '${name}' is missing its system prompt.`, {
          name,
          title,
        });
      }

      const effectiveSettings = resolveSubagentEffectiveSettings({
        persona,
        config: personaConfig,
        riskLevel,
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
            return { kind: "single", toolResult, uiEvent };
          }

          const spawnResult = controlPlane.spawn({
            runtimeConfig,
            prompt,
            title,
            modelLabel,
            originHistoryEntryId: context.turnUserHistoryEntryId,
            config,
            modelResolver: context.modelResolver,
            authPath: context.authPath,
            backend,
            personaId: context.persona.id,
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
          return { kind: "single", toolResult, uiEvent };
        })(),
      };
    },
  };
}
