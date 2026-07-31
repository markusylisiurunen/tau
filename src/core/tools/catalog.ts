import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { SubagentToolName } from "../subagents/types.js";
import type { Persona } from "../types.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { scopeToolExecutionBackend, type ToolExecutionBackend } from "./execution_backend.js";
import { createNookToolDefinition } from "./nook.js";
import { ToolRegistry } from "./registry.js";
import { createSendInputToAgentToolDefinition } from "./send_input_to_agent.js";
import { createSpawnAgentToolDefinition, type ResolveSubagentRuntime } from "./spawn_agent.js";
import { createTerminateAgentToolDefinition } from "./terminate_agent.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
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
  }): ToolRegistry {
    return this.createSessionRegistry({
      ...options,
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
    resolveSubagentRuntime?: ResolveSubagentRuntime;
  }): ToolRegistry {
    const tools = [
      createBashToolDefinition(options.backend, options.cwd),
      createWriteToolDefinition(options.backend),
      createEditToolDefinition(options.backend),
      createViewImageToolDefinition(options.backend),
      createWebToolDefinition(options.backend, options.config),
      createSpawnAgentToolDefinition({
        backend: options.backend,
        supervisor: options.supervisor,
        persona: options.persona,
        config: options.config,
        modelResolver: options.modelResolver,
        subagentPrompts: options.subagentPrompts,
        cwd: options.cwd,
        ...(options.resolveSubagentRuntime
          ? { resolveSubagentRuntime: options.resolveSubagentRuntime }
          : {}),
      }),
      createSendInputToAgentToolDefinition(options.supervisor),
      createWaitForAgentsToolDefinition(options.supervisor),
      createTerminateAgentToolDefinition(options.supervisor),
    ];
    const enabledToolNames = new Set<string>(options.persona.tools);
    const enabledTools = tools.filter((tool) => enabledToolNames.has(tool.schema.name));
    if (options.config.nook) {
      enabledTools.push(createNookToolDefinition(options.backend, options.config));
    }
    return new ToolRegistry(enabledTools);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    backend: ToolExecutionBackend,
    cwd: string,
    config: Config,
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
      }
    }
    return new ToolRegistry(definitions);
  },
};
