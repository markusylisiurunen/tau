import {
  parseSessionProtocolToolRunPresentation as parseToolRunPresentation,
  SESSION_PROTOCOL_MAX_TOOL_RUN_PRESENTATION_BYTES,
  type SessionProtocolToolRunPresentation,
} from "../../protocol/session_protocol.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_CODE,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_INTERRUPT_AGENT,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TAU_DOCS,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "./tool_names.js";

export {
  parseToolRunPresentation,
  SESSION_PROTOCOL_MAX_TOOL_RUN_PRESENTATION_BYTES as TOOL_RUN_PRESENTATION_MAX_BYTES,
};

export type ToolCardLine = SessionProtocolToolRunPresentation["details"][number];
export type ToolCardLineTone = NonNullable<ToolCardLine["tone"]>;
export type ToolCardWrap = ToolCardLine["wrap"];

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

export type ToolRunPresentation = SessionProtocolToolRunPresentation;

export const TOOL_UI_FACET_VERSION = 3;
export const TOOL_CARD_SUBJECT_MAX_LINES = 8;
export const TOOL_CARD_DEFAULT_DETAILS_MAX_LINES = 7;
export const TOOL_CARD_TRUNCATED_DETAILS_MAX_LINES = 33;
export const TOOL_CARD_MAX_LINE_CHARS = 512;

export type ToolCardSubjectTruncation = {
  maxLines?: number;
  maxLineChars?: number;
  strategy?: "head" | "middle";
};

export type ToolTextTruncation = {
  maxLines: number;
  maxLineChars: number;
  strategy?: "head" | "middle";
};

const GENERIC_TOOL_RUN_ACTION_LABELS: ToolRunActionLabels = {
  preparing: "preparing",
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

const JOB_ACTION_LABELS = {
  list: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued list",
    running: "listing",
    succeeded: "listed",
    failed: "failed to list",
    blocked: "list blocked",
    cancelled: "list cancelled",
  },
  read: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued read",
    running: "reading",
    succeeded: "read",
    failed: "failed to read",
    blocked: "read blocked",
    cancelled: "read cancelled",
  },
  stop: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued stop",
    running: "stopping",
    succeeded: "stopped",
    failed: "failed to stop",
    blocked: "stop blocked",
    cancelled: "stop cancelled",
  },
  wait: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    queued: "queued wait",
    running: "waiting for",
    succeeded: "waited for",
    failed: "failed to wait for",
    blocked: "wait blocked",
    cancelled: "wait cancelled",
  },
};

const TOOL_RUN_ACTION_LABELS: Record<string, ToolRunActionLabels> = {
  [TOOL_NAME_BASH]: {
    ...GENERIC_TOOL_RUN_ACTION_LABELS,
    succeeded: "ran",
  },
  list_bash_jobs: JOB_ACTION_LABELS.list,
  list_code_jobs: JOB_ACTION_LABELS.list,
  read_bash_job: JOB_ACTION_LABELS.read,
  read_code_job: JOB_ACTION_LABELS.read,
  stop_bash_job: JOB_ACTION_LABELS.stop,
  stop_code_job: JOB_ACTION_LABELS.stop,
  wait_for_bash_jobs: JOB_ACTION_LABELS.wait,
  wait_for_code_jobs: JOB_ACTION_LABELS.wait,
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
    ...(tailCount > 0 ? bounded.slice(-tailCount) : []),
  ];
}

export function truncateToolText(text: string, options: ToolTextTruncation): string {
  if (!Number.isInteger(options.maxLines) || options.maxLines < 1) {
    throw new Error("text maxLines must be a positive integer");
  }
  if (!Number.isInteger(options.maxLineChars) || options.maxLineChars < 1) {
    throw new Error("text maxLineChars must be a positive integer");
  }

  return truncateLines(
    text
      .replace(/\r\n?/g, "\n")
      .replace(/\n+$/, "")
      .split("\n")
      .map((line) => ({ text: line, wrap: "word" })),
    options.maxLines,
    options.maxLineChars,
    options.strategy,
  )
    .map((line) => line.text)
    .join("\n");
}

export function truncateToolRunSubject(
  subject: string,
  options: ToolCardSubjectTruncation = {},
): string {
  const maxLines = options.maxLines ?? TOOL_CARD_SUBJECT_MAX_LINES;
  const maxLineChars = options.maxLineChars ?? TOOL_CARD_MAX_LINE_CHARS;
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > TOOL_CARD_SUBJECT_MAX_LINES) {
    throw new Error(`subject maxLines must be between 1 and ${TOOL_CARD_SUBJECT_MAX_LINES}`);
  }
  if (
    !Number.isInteger(maxLineChars) ||
    maxLineChars < 1 ||
    maxLineChars > TOOL_CARD_MAX_LINE_CHARS
  ) {
    throw new Error(`subject maxLineChars must be between 1 and ${TOOL_CARD_MAX_LINE_CHARS}`);
  }

  return truncateToolText(subject, {
    maxLines,
    maxLineChars,
    strategy: options.strategy,
  });
}

function getToolRunActionLabels(toolName: string): ToolRunActionLabels {
  return Object.hasOwn(TOOL_RUN_ACTION_LABELS, toolName)
    ? (TOOL_RUN_ACTION_LABELS[toolName] ?? GENERIC_TOOL_RUN_ACTION_LABELS)
    : GENERIC_TOOL_RUN_ACTION_LABELS;
}

const CHARACTER_WRAPPED_SUBJECT_TOOLS = new Set([
  TOOL_NAME_CODE,
  TOOL_NAME_BASH,
  TOOL_NAME_TAU_DOCS,
  TOOL_NAME_WEB,
  TOOL_NAME_HISTORY,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
]);

export function buildToolRunPresentation(args: {
  toolName: string;
  operation?: string;
  subject: string;
  subjectWrap?: ToolCardWrap;
  subjectTruncation?: ToolCardSubjectTruncation | false;
  details?: ToolCardLineInput[];
  detailTruncation?: ToolCardDetailTruncation;
  metadata?: string[];
  actionOverrides?: Partial<ToolRunActionLabels>;
}): ToolRunPresentation {
  const normalizedSubject = args.subject.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const boundedSubject =
    args.subjectTruncation === false
      ? normalizedSubject
      : truncateToolRunSubject(normalizedSubject, args.subjectTruncation);
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
