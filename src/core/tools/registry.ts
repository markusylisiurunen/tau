import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import type { SubagentControlPlane } from "../subagents/control_plane.js";
import type { SubagentStatus } from "../subagents/types.js";
import type { Persona } from "../types.js";
import type { BashTruncationInfo } from "./bash.js";
import type { ToolName } from "./tool_names.js";

type ToolUiEventWithHeaderTarget = {
  headerTarget: string;
} & (
  | {
      type: "tool_call_streaming";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool_call_queued";
      toolCallId: string;
      toolName: string;
      code?: string;
    }
  | {
      type: "tool_call_blocked";
      toolCallId: string;
      toolName: string;
      reason: string;
    }
  | {
      type: "bash_started";
      toolCallId: string;
      command: string;
    }
  | {
      type: "bash_execution";
      toolCallId: string;
      command: string;
      exitCode: number | null;
      truncationInfo: BashTruncationInfo;
      uiText: ToolUiText;
      durationMs?: number;
      labelOverride?: string;
    }
  | {
      type: "bash_aborted";
      toolCallId: string;
      command: string;
      reason: "aborted" | "interrupted";
    }
  | { type: "bash_blocked"; toolCallId: string; command: string; reason: string }
  | {
      type: "client_tool_finished";
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      uiText: ToolUiText;
    }
  | {
      type: "spawn_agent_started";
      toolCallId: string;
      name: string;
      title: string;
    }
  | {
      type: "spawn_agent_finished";
      toolCallId: string;
      name: string;
      title: string;
      status: "success" | "error";
      agentId?: string;
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "spawn_agent_blocked";
      toolCallId: string;
      name?: string;
      title: string;
      reason: string;
    }
  | {
      type: "send_input_to_agent_started";
      toolCallId: string;
      agentId: string;
      name: string;
      title: string;
    }
  | {
      type: "send_input_to_agent_finished";
      toolCallId: string;
      agentId: string;
      name: string;
      title: string;
      status: "success" | "error";
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "send_input_to_agent_blocked";
      toolCallId: string;
      agentId?: string;
      name?: string;
      title: string;
      reason: string;
    }
  | {
      type: "wait_for_agents_started";
      toolCallId: string;
      agentIds: string[];
      headerTarget: string;
    }
  | {
      type: "wait_for_agents_finished";
      toolCallId: string;
      agentIds: string[];
      headerTarget: string;
      status: "success" | "error";
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "wait_for_agents_blocked";
      toolCallId: string;
      agentIds?: string[];
      headerTarget: string;
      reason: string;
    }
  | {
      type: "terminate_agent_started";
      toolCallId: string;
      agentId: string;
    }
  | {
      type: "terminate_agent_finished";
      toolCallId: string;
      agentId: string;
      status: "success" | "error";
      finalStatus?: SubagentStatus;
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "terminate_agent_blocked";
      toolCallId: string;
      agentId?: string;
      reason: string;
    }
  | {
      type: "code_mode_started";
      toolCallId: string;
      toolName: string;
      code: string;
    }
  | {
      type: "code_mode_finished";
      toolCallId: string;
      toolName: string;
      code: string;
      status: "success" | "error";
      uiText: ToolUiText;
    }
  | {
      type: "code_mode_blocked";
      toolCallId: string;
      toolName: string;
      code: string;
      reason: string;
    }
  | {
      type: "view_image_success";
      toolCallId: string;
      path: string;
      mimeType: string;
      bytes: number;
      uiText: ToolUiText;
    }
  | { type: "view_image_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "write_success";
      toolCallId: string;
      path: string;
      bytes: number;
      lines: number;
      content: string;
      uiText: ToolUiText;
    }
  | { type: "write_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "edit_success";
      toolCallId: string;
      path: string;
      oldLength: number;
      newLength: number;
      oldText: string;
      newText: string;
      uiText: ToolUiText;
    }
  | { type: "edit_blocked"; toolCallId: string; path: string; reason: string }
);

export type ToolUiEvent =
  | ToolUiEventWithHeaderTarget
  | {
      type: "tool_pruned";
      toolCallId: string;
      content: string;
    };

export type ToolUiLineTone = "diffAdd" | "diffRemove";

export type ToolUiLine = {
  text: string;
  tone?: ToolUiLineTone;
};

export type ToolUiText = {
  previewLines: ToolUiLine[];
  statusLine?: string;
  fullLines: ToolUiLine[];
};

export type ToolDispatchResult = {
  toolResult: ToolResultMessage;
  uiEvent?: ToolUiEvent;
};

export type ToolDispatch = {
  startedUiEvent?: ToolUiEvent;
  run: Promise<ToolDispatchResult>;
};

export function createToolDispatch(
  run: ToolDispatchResult | (() => ToolDispatchResult | Promise<ToolDispatchResult>),
  startedUiEvent?: ToolUiEvent,
): ToolDispatch {
  return {
    startedUiEvent,
    run: typeof run === "function" ? Promise.resolve().then(run) : Promise.resolve(run),
  };
}

type ToolDispatchBaseContext = {
  config: Config;
  originHistoryEntryId: string;
  cwd: string;
  toolRegistry: ToolRegistry;
  modelResolver: ModelResolver;
  authPath: string;
};

export type ResolvedSubagentRuntime = {
  persona: Persona;
  config: Config;
  modelResolver: ModelResolver;
  subagentPrompts: Record<string, string>;
};

export type ResolveSubagentRuntime = (options: {
  cwd: string;
  persona: Persona;
}) => Promise<ResolvedSubagentRuntime>;

export type MainToolDispatchContext = ToolDispatchBaseContext & {
  scope: "main";
  persona: Persona;
  home: string;
  includeAgentContext: boolean;
  subagentPrompts: Record<string, string>;
  resolveSubagentRuntime?: ResolveSubagentRuntime;
  subagentControlPlane: SubagentControlPlane;
};

export type SubagentToolDispatchContext = ToolDispatchBaseContext & {
  scope: "subagent";
};

export type ToolDispatchContext = MainToolDispatchContext | SubagentToolDispatchContext;

export function isMainToolDispatchContext(
  context: ToolDispatchContext,
): context is MainToolDispatchContext {
  return context.scope === "main";
}

export interface ToolDefinition {
  readonly schema: Tool;
  getDisplayTarget(toolCall: ToolCall, context: ToolDispatchContext): string;
  getCodePreview?(toolCall: ToolCall, context: ToolDispatchContext): string;
  dispatch(
    toolCall: ToolCall,
    signal: AbortSignal,
    context: ToolDispatchContext,
  ): Promise<ToolDispatch>;
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(definitions: ToolDefinition[]) {
    for (const def of definitions) {
      this.byName.set(def.schema.name, def);
    }
  }

  get schemas(): Tool[] {
    return [...this.byName.values()].map((d) => d.schema);
  }

  get(toolName: string): ToolDefinition | undefined {
    return this.byName.get(toolName);
  }

  getEnabledToolSchemas(personaTools?: ToolName[]): Tool[] {
    if (!personaTools) {
      return this.schemas;
    }

    return personaTools.map((toolName) => {
      const definition = this.byName.get(toolName);
      if (!definition) {
        throw new Error(`tool '${toolName}' is not registered`);
      }
      return definition.schema;
    });
  }
}
