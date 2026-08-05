import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { SessionProtocolGoal } from "../../protocol/session_protocol.js";
import { buildBlockedGoalInstruction, buildGoalPolicy, formatGoalState } from "../session/goal.js";
import { parseToolArgs } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import {
  buildToolRunPresentation,
  type ToolCardLineInput,
  type ToolRunActionLabels,
} from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
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
const GOAL_ACTION_LABELS: Record<string, ToolRunActionLabels> = {
  [TOOL_NAME_GET_GOAL]: {
    preparing: "preparing check",
    queued: "queued check",
    running: "checking",
    succeeded: "checked",
    failed: "failed to check",
    blocked: "check blocked",
    cancelled: "check cancelled",
  },
  [TOOL_NAME_CREATE_GOAL]: {
    preparing: "preparing creation",
    queued: "queued creation",
    running: "creating",
    succeeded: "created",
    failed: "failed to create",
    blocked: "creation blocked",
    cancelled: "creation cancelled",
  },
  [TOOL_NAME_UPDATE_GOAL]: {
    preparing: "preparing update",
    queued: "queued update",
    running: "updating",
    succeeded: "updated",
    failed: "failed to update",
    blocked: "update blocked",
    cancelled: "update cancelled",
  },
};

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
    createGoalTool(GET_GOAL_TOOL, emptyArgsSchema, () => formatGoalState(manager.getGoal())),
    createGoalTool(CREATE_GOAL_TOOL, createArgsSchema, async ({ objective }) => {
      const goal = await manager.createGoal(objective);
      return {
        text: `Session goal created.\n\n${buildGoalPolicy(goal)}`,
        presentation: {
          details: [{ text: goal.objective }],
          preserveDetails: true,
        },
      };
    }),
    createGoalTool(UPDATE_GOAL_TOOL, updateArgsSchema, async (update) => {
      const goal = await manager.updateGoal(update);
      if (goal === null) {
        return "The session goal is complete and has been cleared.";
      }
      const instruction =
        goal.status === "active" ? buildGoalPolicy(goal) : buildBlockedGoalInstruction(goal);
      return {
        text: `Session goal updated.\n\n${instruction}`,
        presentation: {
          details: [{ text: goal.objective }],
          preserveDetails: true,
        },
      };
    }),
  ];
}

type GoalToolSuccessPresentation = {
  details: ToolCardLineInput[];
  preserveDetails?: boolean;
};

type GoalToolExecutionResult = {
  text: string;
  presentation?: GoalToolSuccessPresentation;
};

function createGoalTool<T>(
  schema: Tool,
  argsSchema: z.ZodType<T>,
  execute: (
    args: T,
  ) => string | GoalToolExecutionResult | Promise<string | GoalToolExecutionResult>,
): AgentTool {
  const actionOverrides = GOAL_ACTION_LABELS[schema.name];
  if (!actionOverrides) {
    throw new Error(`missing goal action labels for '${schema.name}'`);
  }
  return {
    schema,
    describe: () => ({
      presentation: buildToolRunPresentation({
        toolName: schema.name,
        subject: "goal",
        actionOverrides,
      }),
    }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const finish = (
        text: string,
        outcome: ToolExecutionOutcome["outcome"],
        successPresentation?: GoalToolSuccessPresentation,
      ): ReturnType<typeof createTextToolOutcome> & { uiEvent: ToolActivity } => {
        const preserveDetails = successPresentation?.preserveDetails === true;
        return {
          ...createTextToolOutcome(text, outcome),
          uiEvent: {
            type: "tool_call_finished",
            toolCallId: toolCall.id,
            toolName: schema.name,
            presentation: buildToolRunPresentation({
              toolName: schema.name,
              subject: "goal",
              details: successPresentation?.details ?? [
                { text, ...(outcome === "succeeded" ? {} : { tone: "error" as const }) },
              ],
              ...(preserveDetails
                ? { detailTruncation: false as const, truncateDetailLines: false as const }
                : {}),
              actionOverrides,
            }),
            status: outcome === "succeeded" ? "success" : "error",
          },
        };
      };

      return executeTool(
        context,
        async () => {
          const parsed = parseToolArgs(argsSchema, toolCall.arguments);
          if (!parsed.ok) {
            return finish(`Invalid arguments: ${parsed.error}`, "blocked");
          }
          try {
            const result = await execute(parsed.data);
            return typeof result === "string"
              ? finish(result, "succeeded")
              : finish(result.text, "succeeded", result.presentation);
          } catch (error) {
            return finish(error instanceof Error ? error.message : String(error), "blocked");
          }
        },
        {
          type: "tool_call_started",
          toolCallId: toolCall.id,
          toolName: schema.name,
          presentation: buildToolRunPresentation({
            toolName: schema.name,
            subject: "goal",
            actionOverrides,
          }),
        },
      );
    },
  };
}
