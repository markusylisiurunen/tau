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
export const TOOL_NAME_MCP = "mcp";
export const TOOL_NAME_MODELS = "models";
export const TOOL_NAME_CODE = "code";
export const TOOL_NAME_TAU_DOCS = "tau_docs";

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
  TOOL_NAME_MCP,
  TOOL_NAME_MODELS,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const HOST_TOOL_NAMES = [
  TOOL_NAME_CODE,
  "list_bash_jobs",
  "read_bash_job",
  "stop_bash_job",
  "wait_for_bash_jobs",
  ...TOOL_NAMES.filter((name) => !["web", "history", "nook", "mcp", "models"].includes(name)),
  TOOL_NAME_TAU_DOCS,
] as const;
