import type { Config } from "../config/index.js";
import type { AllowedSubagentToolName } from "../subagents/types.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { createForkToolDefinition } from "./fork.js";
import type { ToolDefinition } from "./registry.js";
import { ToolRegistry } from "./registry.js";
import { createTaskToolDefinition } from "./task.js";
import { createWebFetchToolDefinition } from "./web_fetch.js";
import { createWebSearchToolDefinition } from "./web_search.js";
import { createWriteToolDefinition } from "./write.js";

export const ToolCatalog = {
  createRegistry(backend: ToolExecutionBackend): ToolRegistry {
    return new ToolRegistry([
      createBashToolDefinition(backend),
      createWriteToolDefinition(backend),
      createEditToolDefinition(backend),
      createTaskToolDefinition(),
      createForkToolDefinition(),
    ]);
  },

  createSubagentRegistry(
    allowedTools: AllowedSubagentToolName[],
    config: Config,
    backend: ToolExecutionBackend,
  ): ToolRegistry {
    const definitions: ToolDefinition[] = [];

    for (const tool of allowedTools) {
      switch (tool) {
        case "bash":
          definitions.push(createBashToolDefinition(backend));
          break;
        case "web_search":
          definitions.push(createWebSearchToolDefinition(config));
          break;
        case "web_fetch":
          definitions.push(createWebFetchToolDefinition(config));
          break;
      }
    }

    return new ToolRegistry(definitions);
  },
};
