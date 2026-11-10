import { NotificationInbox } from "../agent/notification_inbox.js";
import type { AgentsCapabilityOptions } from "../code_mode/agents.js";
import type { SessionConfig, SessionRuntimeSettings } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { ResolveSubagentPrompt, SubagentToolName } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { AgentJobRegistry } from "./agent_jobs.js";
import { createJobToolDefinitions } from "./background_jobs.js";
import { createBashToolDefinition } from "./bash.js";
import type { BashJobRegistry } from "./bash_jobs.js";
import { createCodeToolDefinition } from "./code.js";
import type { CodeJobRegistry } from "./code_jobs.js";
import { createEditToolDefinition } from "./edit.js";
import { scopeToolExecutionBackend, type ToolExecutionBackend } from "./execution_backend.js";
import { createNotificationTools } from "./notifications.js";
import { type AgentTool, ToolRegistry } from "./registry.js";
import { createTauDocsToolDefinition } from "./tau_docs.js";
import { TOOL_NAME_BASH } from "./tool_names.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentsToolDefinition } from "./wait_for_agents.js";
import { createWriteToolDefinition } from "./write.js";

function createCommonTools(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  allowedTools: readonly string[];
  config: SessionRuntimeSettings;
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
  history?: HistoryQuery;
  mcp?: McpManager;
  agents?: AgentsCapabilityOptions;
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
    config: SessionConfig;
    persona: Persona;
    modelResolver: ModelResolver;
    history: HistoryQuery;
  }): ToolRegistry {
    const jobs = new AgentJobRegistry();
    return this.createSessionRegistry({
      ...options,
      jobs,
      notifications: new NotificationInbox(),
      ...jobs.create(),
      mcp: new McpManager(options.config.mcpServers),
      subagentSystemPrompt: undefined,
      autoCompactThresholdTokens: options.persona.autoCompactThresholdTokens ?? null,
      supervisor: new AgentSupervisor({ mainAgentId: "main", onEvent: () => {} }),
    });
  },

  createSessionRegistry(options: {
    backend: ToolExecutionBackend;
    cwd: string;
    config: SessionRuntimeSettings;
    persona: Persona;
    subagentSystemPrompt: string | undefined;
    autoCompactThresholdTokens: number | null;
    modelResolver: ModelResolver;
    supervisor: AgentSupervisor;
    notifications: NotificationInbox;
    jobs: AgentJobRegistry;
    bashJobs: BashJobRegistry;
    codeJobs: CodeJobRegistry;
    history: HistoryQuery;
    mcp?: McpManager;
    resolveSubagentPrompt?: ResolveSubagentPrompt;
    clientTools?: () => AgentTool[];
  }): ToolRegistry {
    const tools = [
      createWaitForAgentsToolDefinition(options.supervisor.scope(options.supervisor.mainAgentId)),
    ];
    const enabledToolNames = new Set<string>(options.persona.tools);
    return new ToolRegistry([
      ...createCommonTools({
        ...options,
        allowedTools: options.persona.tools,
        ...(enabledToolNames.has("agents")
          ? { agents: { ...options, callerId: options.supervisor.mainAgentId } }
          : {}),
      }),
      ...(enabledToolNames.has("agents") ? tools : []),
      ...createNotificationTools(options.notifications),
      ...(options.clientTools?.() ?? []),
    ]);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    backend: ToolExecutionBackend,
    cwd: string,
    config: SessionRuntimeSettings,
    bashJobs: BashJobRegistry,
    codeJobs: CodeJobRegistry,
    history?: HistoryQuery,
    mcp?: McpManager,
    agents?: AgentsCapabilityOptions,
  ): ToolRegistry {
    return new ToolRegistry([
      ...createCommonTools({
        backend,
        cwd,
        config,
        bashJobs,
        codeJobs,
        history,
        mcp,
        allowedTools,
        agents,
      }),
      ...(agents
        ? [createWaitForAgentsToolDefinition(agents.supervisor.scope(agents.callerId))]
        : []),
    ]);
  },
};
