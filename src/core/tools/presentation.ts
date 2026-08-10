import { z } from "zod";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_INTERRUPT_AGENT,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_NOOK,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TAU_DOCS,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "./tool_names.js";

export type ToolCardLineTone = "added" | "removed";

export type ToolCardWrap = "word" | "character";

export type ToolCardLine = {
  text: string;
  tone?: ToolCardLineTone;
  wrap: ToolCardWrap;
};

export type ToolCardLineInput = Omit<ToolCardLine, "wrap"> & { wrap?: ToolCardWrap };

export type ToolCardDetailTruncation =
  | false
  | {
      maxLines: number;
      maxLineChars: number;
      strategy: "head" | "middle";
    };

export type ToolRunPresentationStatus =
  | "preparing"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type ToolRunActionLabels = Record<ToolRunPresentationStatus, string>;

export type ToolRunPresentation = {
  actionByStatus: ToolRunActionLabels;
  operation?: string;
  subject: string;
  subjectWrap: ToolCardWrap;
  details: ToolCardLine[];
  metadata: string[];
};

export const TOOL_UI_FACET_VERSION = 3;
export const TOOL_CARD_SUBJECT_MAX_LINES = 8;
export const TOOL_CARD_DEFAULT_DETAILS_MAX_LINES = 7;
export const TOOL_CARD_TRUNCATED_DETAILS_MAX_LINES = 33;
export const TOOL_CARD_MAX_LINE_CHARS = 512;

function isSingleLine(text: string): boolean {
  return !text.includes("\n") && !text.includes("\r");
}

function isBoundedLine(text: string): boolean {
  return isSingleLine(text) && Array.from(text).length <= TOOL_CARD_MAX_LINE_CHARS;
}

const singleLineSchema = z.string().refine(isSingleLine, "must be one line");
const boundedLineSchema = z.string().refine(isBoundedLine, "must be one bounded line");
const boundedLabelSchema = boundedLineSchema.min(1);

const toolCardLineSchema = z
  .object({
    text: singleLineSchema,
    tone: z.enum(["added", "removed"]).optional(),
    wrap: z.enum(["word", "character"]),
  })
  .strict();

const toolRunPresentationSchema: z.ZodType<ToolRunPresentation> = z
  .object({
    actionByStatus: z
      .object({
        preparing: boundedLabelSchema,
        queued: boundedLabelSchema,
        running: boundedLabelSchema,
        succeeded: boundedLabelSchema,
        failed: boundedLabelSchema,
        blocked: boundedLabelSchema,
        cancelled: boundedLabelSchema,
      })
      .strict(),
    operation: boundedLabelSchema.optional(),
    subject: z
      .string()
      .min(1)
      .refine((subject) => {
        const lines = subject.split("\n");
        return lines.length <= TOOL_CARD_SUBJECT_MAX_LINES && lines.every(isBoundedLine);
      }, "must contain only bounded lines"),
    subjectWrap: z.enum(["word", "character"]),
    details: z.array(toolCardLineSchema),
    metadata: z.array(boundedLineSchema),
  })
  .strict();

const GENERIC_TOOL_RUN_ACTION_LABELS: ToolRunActionLabels = {
  preparing: "preparing",
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

const TOOL_RUN_ACTION_LABELS: Record<string, ToolRunActionLabels> = {
  [TOOL_NAME_BASH]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    succeeded: "ran",
  },
  [TOOL_NAME_WRITE]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued write",
    running: "writing",
    succeeded: "wrote",
    failed: "failed to write",
    blocked: "write blocked",
    cancelled: "write cancelled",
  },
  [TOOL_NAME_EDIT]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued edit",
    running: "editing",
    succeeded: "edited",
    failed: "failed to edit",
    blocked: "edit blocked",
    cancelled: "edit cancelled",
  },
  [TOOL_NAME_VIEW_IMAGE]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued view image",
    running: "viewing",
    succeeded: "viewed",
    failed: "failed to view",
    blocked: "view image blocked",
    cancelled: "view image cancelled",
  },
  [TOOL_NAME_SPAWN_AGENT]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued spawn",
    running: "spawning",
    succeeded: "spawned",
    failed: "spawn failed",
    blocked: "spawn blocked",
    cancelled: "spawn cancelled",
  },
  [TOOL_NAME_SEND_INPUT_TO_AGENT]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued input",
    running: "sending input",
    succeeded: "sent input",
    failed: "failed to send input",
    blocked: "send input blocked",
    cancelled: "send input cancelled",
  },
  [TOOL_NAME_WAIT_FOR_AGENTS]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued wait",
    running: "waiting",
    succeeded: "finished waiting",
    failed: "wait failed",
    blocked: "wait blocked",
    cancelled: "wait cancelled",
  },
  [TOOL_NAME_LIST_AGENTS]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued list",
    running: "listing",
    succeeded: "listed",
    failed: "failed to list",
    blocked: "list blocked",
    cancelled: "list cancelled",
  },
  [TOOL_NAME_INTERRUPT_AGENT]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued interruption",
    running: "interrupting",
    succeeded: "interrupted",
    failed: "failed to interrupt",
    blocked: "interruption blocked",
    cancelled: "interruption cancelled",
  },
  [TOOL_NAME_TAU_DOCS]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    preparing: "preparing docs",
    queued: "queued docs read",
    running: "reading docs",
    succeeded: "read docs",
    failed: "failed to read docs",
    blocked: "docs read blocked",
    cancelled: "docs read cancelled",
  },
};

function truncateLine(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, maxChars - 1).join("")}…`;
}

function normalizeLabel(text: string): string {
  return truncateLine(text.replace(/\s+/g, " ").trim(), TOOL_CARD_MAX_LINE_CHARS);
}

export function formatToolDurationMs(durationMs: number): string {
  const ms = Math.round(durationMs);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function truncateLines(
  lines: ToolCardLine[],
  maxLines: number,
  maxLineChars: number,
  strategy: "head" | "middle" = "middle",
): ToolCardLine[] {
  const bounded = lines.map((line) => ({
    ...line,
    text: truncateLine(line.text, maxLineChars),
  }));
  if (bounded.length <= maxLines) return bounded;

  if (strategy === "head") {
    const headCount = maxLines - 1;
    const omitted = bounded.length - headCount;
    return [
      ...bounded.slice(0, headCount),
      {
        text: truncateLine(`…${omitted} more ${omitted === 1 ? "line" : "lines"}…`, maxLineChars),
        wrap: "word",
      },
    ];
  }

  const headCount = Math.ceil((maxLines - 1) / 2);
  const tailCount = maxLines - headCount - 1;
  const omitted = bounded.length - headCount - tailCount;
  return [
    ...bounded.slice(0, headCount),
    {
      text: truncateLine(`…${omitted} more ${omitted === 1 ? "line" : "lines"}…`, maxLineChars),
      wrap: "word",
    },
    ...bounded.slice(-tailCount),
  ];
}

export function parseToolRunPresentation(value: unknown): ToolRunPresentation {
  return toolRunPresentationSchema.parse(value);
}

function getToolRunActionLabels(toolName: string): ToolRunActionLabels {
  return Object.hasOwn(TOOL_RUN_ACTION_LABELS, toolName)
    ? (TOOL_RUN_ACTION_LABELS[toolName] ?? GENERIC_TOOL_RUN_ACTION_LABELS)
    : GENERIC_TOOL_RUN_ACTION_LABELS;
}

const CHARACTER_WRAPPED_SUBJECT_TOOLS = new Set([
  TOOL_NAME_BASH,
  TOOL_NAME_TAU_DOCS,
  TOOL_NAME_WEB,
  TOOL_NAME_HISTORY,
  TOOL_NAME_NOOK,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
]);

export function buildToolRunPresentation(args: {
  toolName: string;
  operation?: string;
  subject: string;
  subjectWrap?: ToolCardWrap;
  details?: ToolCardLineInput[];
  detailTruncation?: ToolCardDetailTruncation;
  metadata?: string[];
  actionOverrides?: Partial<ToolRunActionLabels>;
}): ToolRunPresentation {
  const subjectLines = args.subject.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const boundedSubject = truncateLines(
    subjectLines.map((text) => ({ text, wrap: "word" })),
    TOOL_CARD_SUBJECT_MAX_LINES,
    TOOL_CARD_MAX_LINE_CHARS,
  )
    .map((line) => line.text)
    .join("\n");
  const labels = { ...getToolRunActionLabels(args.toolName), ...args.actionOverrides };
  for (const status of Object.keys(labels) as ToolRunPresentationStatus[]) {
    labels[status] = normalizeLabel(labels[status]) || GENERIC_TOOL_RUN_ACTION_LABELS[status];
  }
  const details = (args.details ?? []).flatMap((line) =>
    line.text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((text) => ({ ...line, text, wrap: line.wrap ?? "word" })),
  );
  const detailTruncation = args.detailTruncation ?? {
    maxLines: TOOL_CARD_DEFAULT_DETAILS_MAX_LINES,
    maxLineChars: TOOL_CARD_MAX_LINE_CHARS,
    strategy: "middle",
  };
  if (detailTruncation !== false) {
    if (
      !Number.isInteger(detailTruncation.maxLines) ||
      detailTruncation.maxLines < 1 ||
      detailTruncation.maxLines > TOOL_CARD_TRUNCATED_DETAILS_MAX_LINES
    ) {
      throw new Error(
        `detail maxLines must be between 1 and ${TOOL_CARD_TRUNCATED_DETAILS_MAX_LINES}`,
      );
    }
    if (!Number.isInteger(detailTruncation.maxLineChars) || detailTruncation.maxLineChars < 1) {
      throw new Error("detail maxLineChars must be a positive integer");
    }
  }
  const boundedDetails =
    detailTruncation === false
      ? details
      : truncateLines(
          details,
          detailTruncation.maxLines,
          detailTruncation.maxLineChars,
          detailTruncation.strategy,
        );

  return parseToolRunPresentation({
    actionByStatus: labels,
    ...(args.operation ? { operation: normalizeLabel(args.operation) } : {}),
    subject: boundedSubject || args.toolName,
    subjectWrap:
      args.subjectWrap ??
      (CHARACTER_WRAPPED_SUBJECT_TOOLS.has(args.toolName) ? "character" : "word"),
    details: boundedDetails,
    metadata: (args.metadata ?? []).map(normalizeLabel).filter((part) => part.length > 0),
  });
}
