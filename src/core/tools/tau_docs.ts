import { readFileSync } from "node:fs";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { formatTokenEstimate } from "../utils/token.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import { buildToolRunPresentation } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { TOOL_NAME_TAU_DOCS } from "./tool_names.js";

const TAU_DOCS_DESCRIPTION = [
  [
    "Read the user documentation shipped with the running Tau version, which may differ from Tau source code in your working directory.",
    "Use it to operate or configure Tau, to use the OpenRouter command-line tool, or when the user asks you to consult Tau's documentation. A mention of Tau alone is no reason to read it.",
    "In a Tau source checkout, read the source and tests instead for questions about implementation, built-in content, defaults, or the current branch.",
    "The documentation does not show the effective local configuration.",
    "Start with index.md.",
  ].join(" "),
  "",
  "The OpenRouter command-line tool, `tau tool openrouter`, runs through Bash and calls a selection of AI models for tasks such as analysis, writing, and typed decisions, with text, image, audio, or video inputs depending on the model. Read openrouter.md before you use it, unless its instructions are already in context. Where you run commands, it may lack its executable or credentials, so follow the page's prerequisites. If it is unavailable, use another approach or explain what blocks you.",
].join("\n");

const documentationRoot = new URL("../static/tau_docs/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", documentationRoot), "utf8"),
) as unknown;
const manifestSchema = z.object({ files: z.array(z.string()).min(1) }).strict();
const documentationPaths = manifestSchema.parse(manifest).files;
const documentationPathSet = new Set(documentationPaths);

export const TAU_DOCS_TOOL: Tool = {
  name: TOOL_NAME_TAU_DOCS,
  description: TAU_DOCS_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({
        description:
          "Exact flat .md path from the Tau documentation index or this tool description.",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*\\.md$",
      }),
    },
    { additionalProperties: false },
  ),
};

const tauDocsArgsSchema = z
  .object({
    path: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, "must be a flat lowercase-dash .md path"),
  })
  .strict();

function parseTauDocsArgs(
  raw: unknown,
): { ok: true; data: { path: string } } | { ok: false; error: string } {
  const parsed = tauDocsArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

function getTauDocsSubject(raw: unknown): string {
  const parsed = parseTauDocsArgs(raw);
  return parsed.ok ? parsed.data.path : "(invalid path)";
}

export function createTauDocsToolDefinition(): AgentTool {
  return {
    schema: TAU_DOCS_TOOL,
    describe: (toolCall) => ({
      presentation: buildToolRunPresentation({
        toolName: TOOL_NAME_TAU_DOCS,
        subject: getTauDocsSubject(toolCall.arguments),
      }),
    }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      return executeTool(context, async () => {
        const parsedArgs = parseTauDocsArgs(toolCall.arguments);
        const subject = getTauDocsSubject(toolCall.arguments);

        const blocked = (
          reason: string,
          semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
        ): ToolImplementationOutcome => {
          const outcome = createTextToolOutcome(reason, semanticOutcome);
          const uiEvent: ToolActivity = {
            type: "tool_call_blocked",
            toolCallId: toolCall.id,
            toolName: TOOL_NAME_TAU_DOCS,
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_TAU_DOCS,
              subject,
              details: [{ text: reason }],
            }),
            reason,
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        };

        if (!parsedArgs.ok) {
          return blocked(`Invalid arguments: ${parsedArgs.error}`);
        }

        const { path } = parsedArgs.data;
        if (!documentationPathSet.has(path)) {
          return blocked(
            `Unknown Tau documentation path '${path}'. Read index.md for valid paths.`,
          );
        }

        try {
          const content = readFileSync(new URL(path, documentationRoot), "utf8");
          const detailText = content.replace(/\r\n?/g, "\n").trimEnd();
          const details = detailText ? detailText.split("\n").map((text) => ({ text })) : [];
          const outcome = createTextToolOutcome(content, "succeeded");
          const uiEvent: ToolActivity = {
            type: "tool_call_finished",
            toolCallId: toolCall.id,
            toolName: TOOL_NAME_TAU_DOCS,
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_TAU_DOCS,
              subject: path,
              details,
              metadata: [
                formatTokenEstimate(Buffer.byteLength(content)),
                `${details.length} ${details.length === 1 ? "line" : "lines"}`,
              ],
            }),
            status: "success",
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return blocked(`Could not read Tau documentation: ${message}`, "failed");
        }
      });
    },
  };
}
