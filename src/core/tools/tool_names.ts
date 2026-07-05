export const TOOL_NAME_BASH = "bash";
export const TOOL_NAME_WRITE = "write";
export const TOOL_NAME_EDIT = "edit";
export const TOOL_NAME_VIEW_IMAGE = "view_image";
export const TOOL_NAME_DIFF_REVIEW = "diff_review";
export const TOOL_NAME_SPAWN_AGENT = "spawn_agent";
export const TOOL_NAME_SEND_INPUT_TO_AGENT = "send_input_to_agent";
export const TOOL_NAME_WAIT_FOR_AGENTS = "wait_for_agents";
export const TOOL_NAME_TERMINATE_AGENT = "terminate_agent";
export const TOOL_NAME_EMIT_OUTPUT = "emit_output";
export const TOOL_NAME_WEB_SEARCH = "web_search";
export const TOOL_NAME_WEB_FETCH = "web_fetch";
export const TOOL_NAME_READ = "read";
export const TOOL_NAME_LIST = "list";
export const TOOL_NAME_GREP = "grep";

export const TOOL_NAMES = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_TERMINATE_AGENT,
  TOOL_NAME_EMIT_OUTPUT,
  TOOL_NAME_WEB_SEARCH,
  TOOL_NAME_WEB_FETCH,
  TOOL_NAME_READ,
  TOOL_NAME_LIST,
  TOOL_NAME_GREP,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
