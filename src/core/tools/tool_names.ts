export const TOOL_NAME_BASH = "bash";
export const TOOL_NAME_WRITE = "write";
export const TOOL_NAME_EDIT = "edit";
export const TOOL_NAME_VIEW_IMAGE = "view_image";
export const TOOL_NAME_DIFF_REVIEW = "diff_review";
export const TOOL_NAME_PREFILL_INPUT = "prefill_input";
export const TOOL_NAME_SPAWN_AGENT = "spawn_agent";
export const TOOL_NAME_SEND_INPUT_TO_AGENT = "send_input_to_agent";
export const TOOL_NAME_WAIT_FOR_AGENTS = "wait_for_agents";
export const TOOL_NAME_LIST_AGENTS = "list_agents";
export const TOOL_NAME_INTERRUPT_AGENT = "interrupt_agent";
export const TOOL_NAME_WEB = "web";
export const TOOL_NAME_NOOK = "nook";
export const TOOL_NAME_HISTORY = "history";
export const TOOL_NAME_GET_GOAL = "get_goal";
export const TOOL_NAME_CREATE_GOAL = "create_goal";
export const TOOL_NAME_UPDATE_GOAL = "update_goal";

export const TOOL_NAMES = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_INTERRUPT_AGENT,
  TOOL_NAME_WEB,
  TOOL_NAME_NOOK,
  TOOL_NAME_HISTORY,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
