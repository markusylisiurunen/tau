import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { ModelResolver } from "../models/catalog.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { SubagentToolName } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { scopeToolExecutionBackend, type ToolExecutionBackend } from "./execution_backend.js";
import { createGoalToolDefinitions, type GoalManager } from "./goal.js";
import { createHistoryToolDefinition } from "./history.js";
import { createInterruptAgentToolDefinition } from "./interrupt_agent.js";
import { createListAgentsToolDefinition } from "./list_agents.js";
import { createNookToolDefinition } from "./nook.js";
import { ToolRegistry } from "./registry.js";
import { createSendInputToAgentToolDefinition } from "./send_input_to_agent.js";
import { createSpawnAgentToolDefinition, type ResolveSubagentRuntime } from "./spawn_agent.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "./tool_names.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentsToolDefinition } from "./wait_for_agents.js";
import { createWebToolDefinition } from "./web.js";
import { createWriteToolDefinition } from "./write.js";

export const ToolCatalog = {
  createDebugRegistry(options: {
    backend: ToolExecutionBackend;
    cwd: string;
    config: Config;
    persona: Persona;
    modelResolver: ModelResolver;
    history: HistoryQuery;
  }): ToolRegistry {
    return this.createSessionRegistry({
      ...options,
      goalManager: {
        getGoal: () => null,
        createGoal: async () => {
          throw new Error("goal mutations are unavailable in the debug registry");
        },
        updateGoal: async () => {
          throw new Error("goal mutations are unavailable in the debug registry");
        },
      },
      subagentPrompts: {},
      supervisor: new AgentSupervisor({ onEvent: () => {} }),
    });
  },

  createSessionRegistry(options: {
    backend: ToolExecutionBackend;
    cwd: string;
    config: Config;
    persona: Persona;
    subagentPrompts: Record<string, string>;
    modelResolver: ModelResolver;
    supervisor: AgentSupervisor;
    goalManager: GoalManager;
    history: HistoryQuery;
    resolveSubagentRuntime?: ResolveSubagentRuntime;
  }): ToolRegistry {
    const tools = [
      createBashToolDefinition(options.backend, options.cwd),
      createWriteToolDefinition(options.backend),
      createEditToolDefinition(options.backend),
      createViewImageToolDefinition(options.backend),
      createWebToolDefinition(options.backend, options.config),
      createHistoryToolDefinition(options.backend, options.history),
      createSpawnAgentToolDefinition({
        backend: options.backend,
        supervisor: options.supervisor,
        persona: options.persona,
        config: options.config,
        modelResolver: options.modelResolver,
        subagentPrompts: options.subagentPrompts,
        history: options.history,
        cwd: options.cwd,
        ...(options.resolveSubagentRuntime
          ? { resolveSubagentRuntime: options.resolveSubagentRuntime }
          : {}),
      }),
      createSendInputToAgentToolDefinition(options.supervisor),
      createWaitForAgentsToolDefinition(options.supervisor),
      createListAgentsToolDefinition(options.supervisor),
      createInterruptAgentToolDefinition(options.supervisor),
    ];
    if (options.config.nook) {
      tools.push(createNookToolDefinition(options.backend, options.config));
    }
    const enabledToolNames = new Set<string>(options.persona.tools);
    return new ToolRegistry([
      ...tools.filter((tool) => enabledToolNames.has(tool.schema.name)),
      ...createGoalToolDefinitions(options.goalManager),
    ]);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    backend: ToolExecutionBackend,
    cwd: string,
    config: Config,
    history?: HistoryQuery,
  ): ToolRegistry {
    const scopedBackend = scopeToolExecutionBackend(backend, cwd);
    const definitions = [];
    const seen = new Set<string>();
    for (const tool of allowedTools) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      switch (tool) {
        case TOOL_NAME_BASH:
          definitions.push(createBashToolDefinition(scopedBackend, cwd));
          break;
        case TOOL_NAME_WRITE:
          definitions.push(createWriteToolDefinition(scopedBackend));
          break;
        case TOOL_NAME_EDIT:
          definitions.push(createEditToolDefinition(scopedBackend));
          break;
        case TOOL_NAME_VIEW_IMAGE:
          definitions.push(createViewImageToolDefinition(scopedBackend));
          break;
        case TOOL_NAME_WEB:
          definitions.push(createWebToolDefinition(scopedBackend, config));
          break;
        case TOOL_NAME_HISTORY:
          if (!history) {
            throw new Error("history query is required when history is enabled for a subagent");
          }
          definitions.push(createHistoryToolDefinition(scopedBackend, history));
          break;
      }
    }
    return new ToolRegistry(definitions);
  },
};
