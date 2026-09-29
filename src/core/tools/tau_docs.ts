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
    "Read the user-facing documentation shipped with the running Tau version (the Tau host providing this tool, not Tau source code in the agent's workspace).",
    "Use when needed to operate or configure Tau, to use the command-line tools described below, or when the user explicitly asks to consult Tau's documentation.",
    "Do not call it merely because Tau is mentioned.",
    "In a Tau source checkout, inspect source and tests instead for questions about implementation, built-in content, defaults, or current branch behavior.",
    "The documentation does not report effective local configuration.",
    "Begin with index.md for general documentation, or read a command-line tool's listed page directly.",
  ].join(" "),
  "",
  "### Built-in command-line tools",
  "",
  "Tau includes command-line tools that agents can invoke through Bash. Each tool has a dedicated documentation page describing its requirements, supported operations, and usage. The summaries below provide discovery without loading the full instructions.",
  "",
  "Available tools:",
  "- PDF unpacking: extract OCR text, tables, and page-image patches from a PDF. Documentation: pdf-unpacking.md.",
  "- Image generation: generate images from prompts or edit images using local references. Documentation: image-generation.md.",
  "- Speech generation: turn narration or multi-speaker dialogue scripts into an audio file. Documentation: speech-generation.md.",
  "",
  "Guidelines:",
  "- Selection: Consider these tools when their capabilities match the task, even if the user has not explicitly named them. Their use is optional; choose the approach that best fits the request.",
  "- Documentation: Before using a tool, read its listed page directly through tau_docs. Load only the relevant guides, and reuse instructions already visible in context.",
  "- Execution: Follow the guide's prerequisites and usage instructions. Tools run in the execution environment; listing a tool here does not guarantee its executable, dependencies, or credentials are available there.",
  "- Scope: Tool availability does not expand the user's request or authorize unrelated actions. If a tool is unavailable or unsuitable, use another appropriate approach or explain the blocker.",
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
