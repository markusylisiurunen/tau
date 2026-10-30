import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { SubagentToolName } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { AgentJobRegistry } from "./agent_jobs.js";
import { createJobToolDefinitions } from "./background_jobs.js";
import { createBashToolDefinition } from "./bash.js";
import type { BashJobRegistry } from "./bash_jobs.js";
import { createCodeToolDefinition } from "./code.js";
import type { CodeJobRegistry } from "./code_jobs.js";
import { createEditToolDefinition } from "./edit.js";
import { scopeToolExecutionBackend, type ToolExecutionBackend } from "./execution_backend.js";
import { createInterruptAgentToolDefinition } from "./interrupt_agent.js";
import { createListAgentsToolDefinition } from "./list_agents.js";
import { type AgentTool, ToolRegistry } from "./registry.js";
import { createSendInputToAgentToolDefinition } from "./send_input_to_agent.js";
import { createSpawnAgentToolDefinition, type ResolveSubagentPrompt } from "./spawn_agent.js";
import { createTauDocsToolDefinition } from "./tau_docs.js";
import { TOOL_NAME_BASH } from "./tool_names.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentsToolDefinition } from "./wait_for_agents.js";
import { createWriteToolDefinition } from "./write.js";

function createCommonTools(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  allowedTools: readonly string[];
  config: Config;
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
  history?: HistoryQuery;
  mcp?: McpManager;
}): AgentTool[] {
  const backend = scopeToolExecutionBackend(options.backend, options.cwd);
  const enabled = new Set(options.allowedTools);
  const tools = [
    createBashToolDefinition(backend, options.cwd, options.bashJobs),
    createWriteToolDefinition(backend),
    createEditToolDefinition(backend),
    createViewImageToolDefinition(backend),
  ];
  const code = createCodeToolDefinition({ ...options, backend });
  return [
    ...tools.filter((tool) => enabled.has(tool.schema.name)),
    ...(code ? [code, ...createJobToolDefinitions(options.codeJobs, "code")] : []),
    ...(enabled.has(TOOL_NAME_BASH) ? createJobToolDefinitions(options.bashJobs, "bash") : []),
    createTauDocsToolDefinition(),
  ];
}

export const ToolCatalog = {
  createDebugRegistry(options: {
    backend: ToolExecutionBackend;
    cwd: string;
    config: Config;
    persona: Persona;
    modelResolver: ModelResolver;
    history: HistoryQuery;
  }): ToolRegistry {
    const jobs = new AgentJobRegistry();
    return this.createSessionRegistry({
      ...options,
      jobs,
      ...jobs.create(),
      mcp: new McpManager(options.config.mcpServers),
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
    jobs: AgentJobRegistry;
    bashJobs: BashJobRegistry;
    codeJobs: CodeJobRegistry;
    history: HistoryQuery;
    mcp?: McpManager;
    resolveSubagentPrompt?: ResolveSubagentPrompt;
    clientTools?: () => AgentTool[];
  }): ToolRegistry {
    const tools = [
      createSpawnAgentToolDefinition({
        backend: options.backend,
        supervisor: options.supervisor,
        jobs: options.jobs,
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
    const enabledToolNames = new Set<string>(options.persona.tools);
    return new ToolRegistry([
      ...createCommonTools({ ...options, allowedTools: options.persona.tools }),
      ...tools.filter((tool) => enabledToolNames.has(tool.schema.name)),
      ...(options.clientTools?.() ?? []),
    ]);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    backend: ToolExecutionBackend,
    cwd: string,
    config: Config,
    bashJobs: BashJobRegistry,
    codeJobs: CodeJobRegistry,
    history?: HistoryQuery,
    mcp?: McpManager,
  ): ToolRegistry {
    return new ToolRegistry(
      createCommonTools({
        backend,
        cwd,
        config,
        bashJobs,
        codeJobs,
        history,
        mcp,
        allowedTools,
      }),
    );
  },
};
