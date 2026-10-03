import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { SubagentToolName } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { createBashToolDefinition } from "./bash.js";
import { BashJobRegistry, createBashJobToolDefinitions } from "./bash_jobs.js";
import { createCodeToolDefinition } from "./code.js";
import { createEditToolDefinition } from "./edit.js";
import { scopeToolExecutionBackend, type ToolExecutionBackend } from "./execution_backend.js";
import { createGoalToolDefinitions, type GoalManager } from "./goal.js";
import { createInterruptAgentToolDefinition } from "./interrupt_agent.js";
import { createListAgentsToolDefinition } from "./list_agents.js";
import { ToolRegistry } from "./registry.js";
import { createSendInputToAgentToolDefinition } from "./send_input_to_agent.js";
import { createSpawnAgentToolDefinition, type ResolveSubagentPrompt } from "./spawn_agent.js";
import { createTauDocsToolDefinition } from "./tau_docs.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WRITE,
} from "./tool_names.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentsToolDefinition } from "./wait_for_agents.js";
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
      mcp: new McpManager(options.config.mcpServers),
      bashJobs: new BashJobRegistry(),
      goalManager: {
        getGoal: () => null,
        createGoal: async () => {
          throw new Error("goal mutations are unavailable in the debug registry");
        },
        updateGoal: async () => {
          throw new Error("goal mutations are unavailable in the debug registry");
        },
      },
      subagentSystemPrompt: undefined,
      supervisor: new AgentSupervisor({ onEvent: () => {} }),
    });
  },

  createSessionRegistry(options: {
    backend: ToolExecutionBackend;
    cwd: string;
    config: Config;
    persona: Persona;
    subagentSystemPrompt: string | undefined;
    modelResolver: ModelResolver;
    supervisor: AgentSupervisor;
    goalManager: GoalManager;
    bashJobs: BashJobRegistry;
    history: HistoryQuery;
    mcp?: McpManager;
    resolveSubagentPrompt?: ResolveSubagentPrompt;
  }): ToolRegistry {
    const tools = [
      createBashToolDefinition(options.backend, options.cwd, options.bashJobs),
      createWriteToolDefinition(options.backend),
      createEditToolDefinition(options.backend),
      createViewImageToolDefinition(options.backend),
      createSpawnAgentToolDefinition({
        backend: options.backend,
        supervisor: options.supervisor,
        bashJobs: options.bashJobs,
        persona: options.persona,
        config: options.config,
        modelResolver: options.modelResolver,
        subagentSystemPrompt: options.subagentSystemPrompt,
        history: options.history,
        mcp: options.mcp,
        cwd: options.cwd,
        ...(options.resolveSubagentPrompt
          ? { resolveSubagentPrompt: options.resolveSubagentPrompt }
          : {}),
      }),
      createSendInputToAgentToolDefinition(options.supervisor),
      createWaitForAgentsToolDefinition(options.supervisor),
      createListAgentsToolDefinition(options.supervisor),
      createInterruptAgentToolDefinition(options.supervisor),
    ];
    const code = createCodeToolDefinition({ ...options, allowedTools: options.persona.tools });
    const enabledToolNames = new Set<string>(options.persona.tools);
    return new ToolRegistry([
      ...tools.filter((tool) => enabledToolNames.has(tool.schema.name)),
      ...(code ? [code] : []),
      ...(enabledToolNames.has(TOOL_NAME_BASH)
        ? createBashJobToolDefinitions(options.bashJobs)
        : []),
      createTauDocsToolDefinition(),
      ...createGoalToolDefinitions(options.goalManager),
    ]);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    backend: ToolExecutionBackend,
    cwd: string,
    config: Config,
    bashJobs: BashJobRegistry,
    history?: HistoryQuery,
    mcp?: McpManager,
  ): ToolRegistry {
    const scopedBackend = scopeToolExecutionBackend(backend, cwd);
    const definitions = [];
    const seen = new Set<string>();
    for (const tool of allowedTools) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      switch (tool) {
        case TOOL_NAME_BASH:
          definitions.push(createBashToolDefinition(scopedBackend, cwd, bashJobs));
          definitions.push(...createBashJobToolDefinitions(bashJobs));
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
      }
    }
    const code = createCodeToolDefinition({
      backend: scopedBackend,
      cwd,
      allowedTools,
      config,
      bashJobs,
      history,
      mcp,
    });
    return new ToolRegistry([
      ...definitions,
      ...(code ? [code] : []),
      createTauDocsToolDefinition(),
    ]);
  },
};
