import { type AgentCapabilities, mainAgentCapabilities } from "../agent/capabilities.js";
import { NotificationInbox } from "../agent/notification_inbox.js";
import type { AgentsPackageOptions } from "../code_mode/agents.js";
import type { SessionConfig, SessionRuntimeSettings } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { ResolveSubagentPrompt } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { AgentJobRegistry } from "./agent_jobs.js";
import { createJobToolDefinitions } from "./background_jobs.js";
import { createBashToolDefinition } from "./bash.js";
import type { BashJobRegistry } from "./bash_jobs.js";
import { createCodeToolDefinition } from "./code.js";
import type { CodeJobRegistry } from "./code_jobs.js";
import { createEditToolDefinition } from "./edit.js";
import { scopeToolExecutionBackend, type ToolExecutionBackend } from "./execution_backend.js";
import { type AgentTool, ToolRegistry } from "./registry.js";
import { createTauDocsToolDefinition } from "./tau_docs.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentsToolDefinition } from "./wait_for_agents.js";
import { createWriteToolDefinition } from "./write.js";

/** What one agent's tools act on. Every agent gets the same tools; capabilities decide what succeeds. */
export type AgentToolsOptions = {
  backend: ToolExecutionBackend;
  cwd: string;
  config: SessionRuntimeSettings;
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
  history: HistoryQuery;
  mcp: McpManager;
  /** The agent's own inbox, which is empty for agents nothing notifies. */
  notifications: NotificationInbox;
  capabilities: AgentCapabilities;
  /** Required exactly when `capabilities.delegation` is available. */
  agents?: AgentsPackageOptions;
};

function delegationAccess({ capabilities, agents }: AgentToolsOptions) {
  const { delegation } = capabilities;
  if (delegation.available && agents) {
    return { available: true, supervisor: agents.supervisor.scope(agents.callerId) } as const;
  }
  if (!delegation.available && !agents) return delegation;
  throw new Error("agent-management options must be given exactly when delegation is available");
}

function createAgentTools(options: AgentToolsOptions): AgentTool[] {
  const backend = scopeToolExecutionBackend(options.backend, options.cwd);
  return [
    createBashToolDefinition(backend, options.cwd, options.bashJobs),
    createWriteToolDefinition(backend),
    createEditToolDefinition(backend),
    createViewImageToolDefinition(backend),
    createCodeToolDefinition({ ...options, backend }),
    ...createJobToolDefinitions(options.codeJobs, "code"),
    ...createJobToolDefinitions(options.bashJobs, "bash"),
    createWaitForAgentsToolDefinition(delegationAccess(options)),
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
      ...jobs.create(),
      mcp: new McpManager(options.config.mcpServers),
      subagentSystemPrompt: "",
      autoCompactThresholdTokens: options.persona.autoCompactThresholdTokens ?? null,
      supervisor: new AgentSupervisor({
        mainAgentId: "main",
        onEvent: () => {},
        onCompletion: () => {},
      }),
      notifications: new NotificationInbox(),
      capabilities: mainAgentCapabilities({ notifications: true, config: options.config }),
    });
  },

  /** The main agent's tools, which also include the attached clients' tools. */
  createSessionRegistry(
    options: Omit<AgentToolsOptions, "agents"> & {
      persona: Persona;
      subagentSystemPrompt: string;
      autoCompactThresholdTokens: number | null;
      modelResolver: ModelResolver;
      supervisor: AgentSupervisor;
      jobs: AgentJobRegistry;
      resolveSubagentPrompt?: ResolveSubagentPrompt;
      clientTools?: () => AgentTool[];
    },
  ): ToolRegistry {
    return new ToolRegistry([
      ...createAgentTools({
        ...options,
        agents: { ...options, callerId: options.supervisor.mainAgentId },
      }),
      ...(options.clientTools?.() ?? []),
    ]);
  },

  /** Tools for a worker or a side context such as diff review. */
  createSubagentRegistry(options: AgentToolsOptions): ToolRegistry {
    return new ToolRegistry(createAgentTools(options));
  },
};
