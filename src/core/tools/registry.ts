import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolActivity } from "./activity.js";
import type { ToolRunPresentation } from "./presentation.js";

export type ToolExecutionOutcome = {
  content: ToolResultMessage["content"];
  outcome: "succeeded" | "failed" | "blocked" | "cancelled";
};

export type ToolImplementationOutcome = ToolExecutionOutcome & {
  uiEvent?: ToolActivity;
};

export function createTextToolOutcome(
  text: string,
  outcome: ToolExecutionOutcome["outcome"],
): ToolExecutionOutcome {
  return {
    content: [{ type: "text", text }],
    outcome,
  };
}

export async function executeTool(
  context: ToolExecutionContext,
  run:
    | ToolImplementationOutcome
    | (() => ToolImplementationOutcome | Promise<ToolImplementationOutcome>),
  startedUiEvent?: ToolActivity,
): Promise<ToolExecutionOutcome> {
  if (startedUiEvent) {
    await context.emitActivity(startedUiEvent);
  }
  const result = typeof run === "function" ? await run() : run;
  if (result.uiEvent) {
    await context.emitActivity(result.uiEvent);
  }
  return { content: result.content, outcome: result.outcome };
}

export type ToolCallDescription = {
  presentation: ToolRunPresentation;
};

export type ToolExecutionContext = {
  agentId: string;
  turnId: string;
  assistantMessageId: string;
  signal: AbortSignal;
  emitActivity: (activity: ToolActivity) => Promise<void>;
};

export interface AgentTool {
  readonly schema: Tool;
  describe(toolCall: ToolCall): ToolCallDescription;
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}

export class ToolRegistry {
  private readonly byName = new Map<string, AgentTool>();

  constructor(definitions: AgentTool[]) {
    for (const definition of definitions) {
      const name = definition.schema.name;
      if (this.byName.has(name)) {
        throw new Error(`duplicate tool '${name}'`);
      }
      this.byName.set(name, definition);
    }
  }

  get schemas(): Tool[] {
    return [...this.byName.values()].map((definition) => definition.schema);
  }

  get(toolName: string): AgentTool | undefined {
    return this.byName.get(toolName);
  }

  getEnabledTools(toolNames?: string[]): AgentTool[] {
    if (!toolNames) {
      return [...this.byName.values()];
    }

    return toolNames.map((toolName) => {
      const definition = this.byName.get(toolName);
      if (!definition) {
        throw new Error(`tool '${toolName}' is not registered`);
      }
      return definition;
    });
  }

  getEnabledToolSchemas(toolNames?: string[]): Tool[] {
    return this.getEnabledTools(toolNames).map((definition) => definition.schema);
  }
}
