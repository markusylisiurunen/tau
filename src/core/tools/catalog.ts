import type { Config } from "../config/index.js";
import type { SubagentToolName } from "../subagents/types.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { createEmitOutputToolDefinition } from "./emit_output.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition } from "./registry.js";
import { ToolRegistry } from "./registry.js";
import { createSendInputToAgentToolDefinition } from "./send_input_to_agent.js";
import { createSpawnAgentToolDefinition } from "./spawn_agent.js";
import { createTerminateAgentToolDefinition } from "./terminate_agent.js";
import { createViewImageToolDefinition } from "./view_image.js";
import { createWaitForAgentToolDefinition } from "./wait_for_agent.js";
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
      createWaitForAgentToolDefinition(),
      createTerminateAgentToolDefinition(),
    ]);
  },

  createSubagentRegistry(
    allowedTools: SubagentToolName[],
    config: Config,
    backend: ToolExecutionBackend,
  ): ToolRegistry {
    const definitions: ToolDefinition[] = [createEmitOutputToolDefinition()];
    const seen = new Set<string>();

    const addTool = (tool: SubagentToolName): void => {
      if (seen.has(tool)) return;
      seen.add(tool);

      switch (tool) {
        case "bash":
          definitions.push(createBashToolDefinition(backend));
          break;
        case "write":
          definitions.push(createWriteToolDefinition(backend));
          break;
        case "edit":
          definitions.push(createEditToolDefinition(backend));
          break;
        case "view_image":
          definitions.push(createViewImageToolDefinition(backend));
          break;
        case "web_search":
          definitions.push(createWebSearchToolDefinition(config));
          break;
        case "web_fetch":
          definitions.push(createWebFetchToolDefinition(config));
          break;
        case "emit_output":
          break;
      }
    };

    for (const tool of allowedTools) {
      addTool(tool);
    }

    return new ToolRegistry(definitions);
  },
};
