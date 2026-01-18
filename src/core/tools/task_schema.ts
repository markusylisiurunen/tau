import type { Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const TASK_DESCRIPTION = [
  "Run an isolated sub-agent task to completion and return only its final text output.",
  "Use this to delegate narrow exploration or focused work to a constrained sub-agent.",
  "See your system instructions for available sub-agents, their capabilities, and intended use cases.",
].join(" ");

const TASK_NAME_DESCRIPTION = [
  "Sub-agent name to run.",
  "Available sub-agents depend on the current persona configuration.",
].join(" ");
const TASK_TITLE_DESCRIPTION = [
  "A short human-friendly UI title shown while the task runs.",
  "Do not use title case; all lower-case is preferred except for proper nouns.",
].join(" ");
const TASK_PROMPT_DESCRIPTION = [
  "The prompt to send to the sub-agent.",
  "This is the only input the sub-agent will receive; it must be self-contained and specific.",
  "Include all necessary context and instructions in the prompt for the sub-agent to complete the task successfully.",
].join(" ");

export const TASK_TOOL: Tool = {
  name: "task",
  description: TASK_DESCRIPTION,
  parameters: Type.Object(
    {
      name: Type.String({ description: TASK_NAME_DESCRIPTION }),
      title: Type.String({ description: TASK_TITLE_DESCRIPTION }),
      prompt: Type.String({ description: TASK_PROMPT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};
