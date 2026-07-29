import type { Config } from "../config/index.js";
import type { SubagentToolName } from "../subagents/types.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { createNookToolDefinition } from "./nook.js";
import type { ToolDefinition } from "./registry.js";
import { ToolRegistry } from "./registry.js";
import { createSendInputToAgentToolDefinition } from "./send_input_to_agent.js";
import { createSpawnAgentToolDefinition } from "./spawn_agent.js";
import { createTerminateAgentToolDefinition } from "./terminate_agent.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB_FETCH,
  TOOL_NAME_WEB_SEARCH,
  TOOL_NAME_WRITE,
} from "./tool_names.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentsToolDefinition } from "./wait_for_agents.js";
import { createWebFetchToolDefinition } from "./web_fetch.js";
import { createWebSearchToolDefinition } from "./web_search.js";
import { createWriteToolDefinition } from "./write.js";

export const ToolCatalog = {
  createRegistry(backend: ToolExecutionBackend): ToolRegistry {
    return new ToolRegistry([
      createBashToolDefinition(backend),
      createWriteToolDefinition(backend),
      createEditToolDefinition(backend),
      createViewImageToolDefinition(backend),
      createSpawnAgentToolDefinition(backend),
      createSendInputToAgentToolDefinition(backend),
      createWaitForAgentsToolDefinition(),
      createTerminateAgentToolDefinition(),
      createNookToolDefinition(backend),
    ]);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    config: Config,
    backend: ToolExecutionBackend,
  ): ToolRegistry {
    const definitions: ToolDefinition[] = [];
    const seen = new Set<string>();

    const addTool = (tool: SubagentToolName): void => {
      if (seen.has(tool)) return;
      seen.add(tool);

      switch (tool) {
        case TOOL_NAME_BASH:
          definitions.push(createBashToolDefinition(backend));
          break;
        case TOOL_NAME_WRITE:
          definitions.push(createWriteToolDefinition(backend));
          break;
        case TOOL_NAME_EDIT:
          definitions.push(createEditToolDefinition(backend));
          break;
        case TOOL_NAME_VIEW_IMAGE:
          definitions.push(createViewImageToolDefinition(backend));
          break;
        case TOOL_NAME_WEB_SEARCH:
          definitions.push(createWebSearchToolDefinition(config));
          break;
        case TOOL_NAME_WEB_FETCH:
          definitions.push(createWebFetchToolDefinition(config));
          break;
      }
    };

    for (const tool of allowedTools) {
      addTool(tool);
    }

    return new ToolRegistry(definitions);
  },
};
