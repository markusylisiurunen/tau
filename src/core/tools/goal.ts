import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { SessionProtocolGoal } from "../../protocol/session_protocol.js";
import { buildBlockedGoalInstruction, buildGoalPolicy } from "../session/goal.js";
import { parseToolArgs } from "../utils/zod.js";
import {
  type AgentTool,
  createTextToolOutcome,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
} from "./registry.js";
import { TOOL_NAME_CREATE_GOAL, TOOL_NAME_GET_GOAL, TOOL_NAME_UPDATE_GOAL } from "./tool_names.js";

export type GoalManager = {
  getGoal(): SessionProtocolGoal | null;
  createGoal(objective: string): Promise<SessionProtocolGoal>;
  updateGoal(update: {
    objective?: string;
    status?: "complete" | "blocked";
  }): Promise<SessionProtocolGoal | null>;
};

const GET_GOAL_TOOL: Tool = {
  name: TOOL_NAME_GET_GOAL,
  description: "Return the current persisted session goal, or null when no goal exists.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

const CREATE_GOAL_TOOL: Tool = {
  name: TOOL_NAME_CREATE_GOAL,
  description:
    "Create an active persisted session goal. Use this only when the user explicitly asks to create, start, or set a goal, or when system or developer instructions explicitly require one. Never infer a goal from an ordinary task, even when the task is large or multi-step. Continue working on the new goal in the current turn.",
  parameters: Type.Object(
    {
      objective: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
};

const UPDATE_GOAL_TOOL: Tool = {
  name: TOOL_NAME_UPDATE_GOAL,
  description:
    "Update the current persisted goal. Replace objective only when user steering, discovered requirements, or a clearer formulation materially changes the target, never to make completion easier. Set status to complete only after every requirement is achieved and verified; this clears the goal. Set status to blocked only when meaningful progress requires user input or an external state change. An objective update may be combined with blocked, but not complete.",
  parameters: Type.Object(
    {
      objective: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("blocked")])),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
};

const emptyArgsSchema = z.object({}).strict();
const createArgsSchema = z.object({ objective: z.string().trim().min(1) }).strict();
const updateArgsSchema = z
  .object({
    objective: z.string().trim().min(1).optional(),
    status: z.enum(["complete", "blocked"]).optional(),
  })
  .strict()
  .refine((args) => args.objective !== undefined || args.status !== undefined, {
    message: "objective or status is required",
  })
  .refine((args) => !(args.objective !== undefined && args.status === "complete"), {
    message: "objective cannot be combined with complete",
  });

export function createGoalToolDefinitions(manager: GoalManager): AgentTool[] {
  return [
    createGoalTool(GET_GOAL_TOOL, emptyArgsSchema, () => manager.getGoal()),
    createGoalTool(CREATE_GOAL_TOOL, createArgsSchema, async ({ objective }) => {
      const goal = await manager.createGoal(objective);
      return {
        goal,
        instruction: buildGoalPolicy(goal),
      };
    }),
    createGoalTool(UPDATE_GOAL_TOOL, updateArgsSchema, async (update) => {
      const goal = await manager.updateGoal(update);
      if (goal === null) {
        return { goal: null, completed: true };
      }
      return {
        goal,
        instruction:
          goal.status === "active" ? buildGoalPolicy(goal) : buildBlockedGoalInstruction(goal),
      };
    }),
  ];
}

function createGoalTool<T>(
  schema: Tool,
  argsSchema: z.ZodType<T>,
  execute: (args: T) => unknown | Promise<unknown>,
): AgentTool {
  return {
    schema,
    describe: () => ({ headerTarget: "goal" }),
    async execute(
      toolCall: ToolCall,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const parsed = parseToolArgs(argsSchema, toolCall.arguments);
      if (!parsed.ok) {
        return createTextToolOutcome(`Invalid arguments: ${parsed.error}`, "blocked");
      }
      try {
        const result = await execute(parsed.data);
        return createTextToolOutcome(JSON.stringify(result), "succeeded");
      } catch (error) {
        return createTextToolOutcome(
          error instanceof Error ? error.message : String(error),
          "blocked",
        );
      }
    },
  };
}
