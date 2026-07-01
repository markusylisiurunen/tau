import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../tools/tool_names.js";
import type { ReasoningEffort } from "../types.js";
import { buildLineDiff, collapseLongUnchangedDiffRuns } from "../utils/line_diff.js";
import { extractAllFencedCodeBlocks } from "../utils/messages.js";
import { bytesToTokens, formatTokenEstimate, tokensToBytes } from "../utils/token.js";
import { truncateToBytesFromStart } from "../utils/truncate.js";

const DEFAULT_PRUNE_FRACTION = 0.25;
const PRUNED_TOOL_RESULT_PREFIX = "[Tool result pruned]";
const PRUNED_EDIT_RESULT_PREFIX = "[Tool result pruned] Edit diff";
const PRUNED_EDIT_ARGUMENT_MARKER = "[Content pruned]";
const PRUNE_EDIT_UNCHANGED_CONTEXT_LINES = 4;
const PRUNE_PREVIEW_MAX_TOKENS = 512;
const PRUNE_MAX_OVERAGE_RATIO = 0.1;

export type SessionPruneStrategy = "earliest" | "largest" | "smart";

export type PrunableHistoryEntry = {
  id: string;
  message: Message;
};

export type SessionPruneOptions = {
  strategy: SessionPruneStrategy;
  fraction: number;
  guidance?: string;
  smartSelection?: readonly string[];
};

export type SessionPrunedToolResult = {
  toolCallId: string;
  content: string;
};

export type SessionPruneResult = {
  message: string;
  noop: boolean;
  bashResultsPruned: number;
  editCallsPruned: number;
  editResultsPruned: number;
  bytesPruned: number;
  prunedToolResults: SessionPrunedToolResult[];
};

export type SessionSmartPrunePromptRequest = {
  prompt: string;
  targetTokens: number;
};

type ToolResultPruneCandidate = {
  historyEntryId: string;
  toolResult: ToolResultMessage;
  bytes: number;
  tokens: number;
  order: number;
};

type EditPruneCallDiff = {
  oldText: string;
  newText: string;
};

type EditPruneSummary = {
  callsPruned: number;
  resultsPruned: number;
  bytesRemoved: number;
};

type EditPruneResult = EditPruneSummary & {
  prunedToolResults: SessionPrunedToolResult[];
};

type PrunePreparation = {
  candidates: ToolResultPruneCandidate[];
  totalTokens: number;
  targetTokens: number;
};

type ToolResultContentInspection = {
  text: string;
  textBytes: number;
  hasImage: boolean;
  firstText?: string;
};

export function defaultSessionPruneFraction(): number {
  return DEFAULT_PRUNE_FRACTION;
}

export function parseSessionPruneFraction(extra?: string): number | null {
  if (!extra) {
    return DEFAULT_PRUNE_FRACTION;
  }
  const parsed = Number(extra);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed < 0 || parsed > 1) {
    return null;
  }
  return parsed;
}

export function parseSessionPruneFractionAndGuidance(extra?: string): {
  fraction: number | null;
  guidance?: string;
} {
  if (!extra) {
    return { fraction: DEFAULT_PRUNE_FRACTION };
  }

  const trimmed = extra.trim();
  if (!trimmed) {
    return { fraction: DEFAULT_PRUNE_FRACTION };
  }

  const [firstToken, ...rest] = trimmed.split(/\s+/);
  const parsed = Number(firstToken);
  if (Number.isFinite(parsed)) {
    if (parsed < 0 || parsed > 1) {
      return { fraction: null };
    }
    const guidance = rest.join(" ").trim();
    return guidance ? { fraction: parsed, guidance } : { fraction: parsed };
  }

  return { fraction: DEFAULT_PRUNE_FRACTION, guidance: trimmed };
}

export function prepareSessionSmartPrunePrompt(args: {
  historyEntries: readonly PrunableHistoryEntry[];
  fraction: number;
  guidance?: string;
}): SessionSmartPrunePromptRequest | undefined {
  validatePruneFraction(args.fraction);
  if (args.fraction === 0 || args.historyEntries.length === 0) {
    return undefined;
  }

  const preparation = preparePruneCandidates(args.historyEntries, args.fraction);
  if (preparation.candidates.length === 0 || preparation.totalTokens === 0) {
    return undefined;
  }
  if (preparation.targetTokens <= 0) {
    return undefined;
  }

  return {
    prompt: buildSmartPrunePrompt({
      history: args.historyEntries.map((entry) => entry.message),
      targetTokens: preparation.targetTokens,
      guidance: args.guidance,
    }),
    targetTokens: preparation.targetTokens,
  };
}

export function buildSmartPruneSystemPrompt(): string {
  return [
    "You are a context pruning assistant.",
    "Your task is to select which bash tool outputs should be pruned from the conversation history.",
    "Analyze the conversation to understand what the user is working on and which tool outputs are most relevant.",
    "Prioritize keeping outputs that contain important information, errors, or results that may be referenced later.",
    "Prefer pruning outputs that are verbose, redundant, or contain routine information that can be regenerated if needed.",
    "Follow the user's guidance carefully when provided.",
  ].join(" ");
}

export function clampPruneReasoning(
  reasoning?: ReasoningEffort,
): Exclude<ReasoningEffort, "none"> | undefined {
  switch (reasoning) {
    case undefined:
    case "none":
      return undefined;
    case "minimal":
      return "low";
    case "low":
    case "medium":
      return reasoning;
    default:
      return "medium";
  }
}

export function parseSmartPruneResponse(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const fenced = extractAllFencedCodeBlocks(trimmed);
  const source = (fenced ?? trimmed).trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const jsonText = source.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const prune = (parsed as { prune?: unknown }).prune;
  if (!Array.isArray(prune) || prune.some((item) => typeof item !== "string")) {
    return null;
  }

  return prune;
}

export function pruneSessionHistory(args: {
  historyEntries: readonly PrunableHistoryEntry[];
  replaceMessageById: (historyEntryId: string, message: Message) => boolean;
  options: SessionPruneOptions;
}): SessionPruneResult {
  validatePruneFraction(args.options.fraction);

  if (args.options.fraction === 0) {
    return emptyPruneResult("prune fraction is 0, nothing to prune.");
  }
  if (args.historyEntries.length === 0) {
    return emptyPruneResult("no conversation to prune.");
  }

  const editSummary = pruneEditToolHistory(args.historyEntries, args.replaceMessageById);
  const preparation = preparePruneCandidates(args.historyEntries, args.options.fraction);
  const fallbackMessage =
    args.options.strategy === "smart" && args.options.smartSelection?.length === 0
      ? "model returned no prune candidates."
      : "no bash tool results or edit tool calls to prune.";

  if (preparation.candidates.length === 0 || preparation.totalTokens === 0) {
    return buildNoopOrEditResult(editSummary, fallbackMessage);
  }
  if (preparation.targetTokens <= 0) {
    return buildNoopOrEditResult(editSummary, "prune fraction is too small to remove anything.");
  }

  const toPrune =
    args.options.strategy === "smart"
      ? selectSmartPruneCandidates(
          args.options.smartSelection ?? [],
          preparation.candidates,
          preparation.targetTokens,
        )
      : selectPruneCandidatesByStrategy(preparation, args.options.strategy);

  if (toPrune.length === 0) {
    return buildNoopOrEditResult(editSummary, fallbackMessage);
  }

  const applied = applyBashPruneCandidates(toPrune, args.replaceMessageById);
  const message = buildPruneSummaryMessage(editSummary, applied.resultsPruned, applied.bytesPruned);
  return {
    message,
    noop: false,
    bashResultsPruned: applied.resultsPruned,
    editCallsPruned: editSummary.callsPruned,
    editResultsPruned: editSummary.resultsPruned,
    bytesPruned: applied.bytesPruned + editSummary.bytesRemoved,
    prunedToolResults: [...editSummary.prunedToolResults, ...applied.prunedToolResults],
  };
}

function validatePruneFraction(fraction: number): void {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("invalid prune fraction. use a number between 0 and 1.");
  }
}

function emptyPruneResult(message: string): SessionPruneResult {
  return {
    message,
    noop: true,
    bashResultsPruned: 0,
    editCallsPruned: 0,
    editResultsPruned: 0,
    bytesPruned: 0,
    prunedToolResults: [],
  };
}

function buildNoopOrEditResult(
  editSummary: EditPruneResult,
  fallbackMessage: string,
): SessionPruneResult {
  if (!hasAnyPrunedEditChanges(editSummary)) {
    return emptyPruneResult(fallbackMessage);
  }

  return {
    message: buildPruneSummaryMessage(editSummary),
    noop: false,
    bashResultsPruned: 0,
    editCallsPruned: editSummary.callsPruned,
    editResultsPruned: editSummary.resultsPruned,
    bytesPruned: editSummary.bytesRemoved,
    prunedToolResults: editSummary.prunedToolResults,
  };
}

function preparePruneCandidates(
  historyEntries: readonly PrunableHistoryEntry[],
  fraction: number,
): PrunePreparation {
  const candidates: ToolResultPruneCandidate[] = [];
  let totalTokens = 0;

  for (const entry of historyEntries) {
    const message = entry.message;
    if (message.role !== "toolResult") {
      continue;
    }

    const toolResult = message as ToolResultMessage;
    if (toolResult.toolName !== TOOL_NAME_BASH) {
      continue;
    }

    const inspection = inspectToolResultContent(toolResult);
    if (inspection.firstText?.startsWith(PRUNED_TOOL_RESULT_PREFIX) || inspection.hasImage) {
      continue;
    }

    const tokens = bytesToTokens(inspection.textBytes);
    candidates.push({
      historyEntryId: entry.id,
      toolResult,
      bytes: inspection.textBytes,
      tokens,
      order: candidates.length,
    });
    totalTokens += tokens;
  }

  return {
    candidates,
    totalTokens,
    targetTokens: Math.ceil(totalTokens * fraction),
  };
}

function selectPruneCandidatesByStrategy(
  preparation: PrunePreparation,
  strategy: "earliest" | "largest",
): ToolResultPruneCandidate[] {
  const ordered =
    strategy === "largest"
      ? [...preparation.candidates].sort(
          (a, b) => b.tokens - a.tokens || b.bytes - a.bytes || a.order - b.order,
        )
      : preparation.candidates;

  const selected: ToolResultPruneCandidate[] = [];
  let selectedTokens = 0;

  for (const candidate of ordered) {
    if (selectedTokens >= preparation.targetTokens) {
      break;
    }
    selected.push(candidate);
    selectedTokens += candidate.tokens;
  }

  return selected;
}

function selectSmartPruneCandidates(
  ids: readonly string[],
  candidates: readonly ToolResultPruneCandidate[],
  targetTokens: number,
): ToolResultPruneCandidate[] {
  const candidatesById = new Map<string, ToolResultPruneCandidate>();
  for (const candidate of candidates) {
    candidatesById.set(candidate.toolResult.toolCallId, candidate);
  }

  const selected: ToolResultPruneCandidate[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  const maxTokens = Math.ceil(targetTokens * (1 + PRUNE_MAX_OVERAGE_RATIO));

  for (const id of ids) {
    if (seen.has(id)) continue;
    const candidate = candidatesById.get(id);
    if (!candidate) continue;
    if (tokens + candidate.tokens > maxTokens) continue;
    selected.push(candidate);
    seen.add(id);
    tokens += candidate.tokens;
    if (tokens >= targetTokens) {
      break;
    }
  }

  return selected;
}

function applyBashPruneCandidates(
  candidates: readonly ToolResultPruneCandidate[],
  replaceMessageById: (historyEntryId: string, message: Message) => boolean,
): {
  resultsPruned: number;
  bytesPruned: number;
  prunedToolResults: SessionPrunedToolResult[];
} {
  let bytesPruned = 0;
  const prunedToolResults: SessionPrunedToolResult[] = [];

  for (const candidate of candidates) {
    bytesPruned += candidate.bytes;
    const noticeText = buildPrunedToolResultNotice(candidate.toolResult, candidate.bytes);
    const prunedResult: ToolResultMessage = {
      ...candidate.toolResult,
      content: [{ type: "text", text: noticeText }],
    };
    replacePrunedMessageOrThrow(
      replaceMessageById,
      candidate.historyEntryId,
      prunedResult,
      "bash tool result",
    );
    prunedToolResults.push({ toolCallId: prunedResult.toolCallId, content: noticeText });
  }

  return { resultsPruned: candidates.length, bytesPruned, prunedToolResults };
}

function hasAnyPrunedEditChanges(summary: EditPruneSummary): boolean {
  return summary.callsPruned > 0 || summary.resultsPruned > 0;
}

function buildPruneSummaryMessage(
  editSummary: EditPruneSummary,
  bashResultsPruned: number = 0,
  bashBytesPruned: number = 0,
): string {
  const editSummaryText = formatPrunedEditSummary(editSummary);

  if (bashResultsPruned <= 0) {
    if (!editSummaryText) {
      return "no bash tool results or edit tool calls to prune.";
    }
    return `pruned ${editSummaryText}.`;
  }

  const bashLabel = formatTokenEstimate(bashBytesPruned);
  const bashNoun = bashResultsPruned === 1 ? "result" : "results";
  if (!editSummaryText) {
    return `pruned ${bashResultsPruned} bash tool ${bashNoun} (${bashLabel}).`;
  }

  return `pruned ${bashResultsPruned} bash tool ${bashNoun} (${bashLabel}) and ${editSummaryText}.`;
}

function formatPrunedEditSummary(summary: EditPruneSummary): string {
  if (!hasAnyPrunedEditChanges(summary)) {
    return "";
  }

  const parts: string[] = [];
  if (summary.callsPruned > 0) {
    const noun = summary.callsPruned === 1 ? "call" : "calls";
    parts.push(`${summary.callsPruned} edit tool ${noun}`);
  }
  if (summary.resultsPruned > 0) {
    const noun = summary.resultsPruned === 1 ? "result" : "results";
    parts.push(`${summary.resultsPruned} edit tool ${noun}`);
  }

  const tokenEstimate = formatTokenEstimate(summary.bytesRemoved);
  return `${parts.join(" and ")} (${tokenEstimate})`;
}

function pruneEditToolHistory(
  historyEntries: readonly PrunableHistoryEntry[],
  replaceMessageById: (historyEntryId: string, message: Message) => boolean,
): EditPruneResult {
  const summary: EditPruneResult = {
    callsPruned: 0,
    resultsPruned: 0,
    bytesRemoved: 0,
    prunedToolResults: [],
  };
  const editCallsById = new Map<string, EditPruneCallDiff>();

  for (const entry of historyEntries) {
    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }

    const assistant = message as AssistantMessage;
    const assistantContent = getAssistantContentOrThrow(assistant, "pruning edit tool calls");

    let changed = false;
    const nextContent = assistantContent.map((block) => {
      if (block.type !== "toolCall") {
        return block;
      }

      const toolCall = block as ToolCall;
      if (toolCall.name !== TOOL_NAME_EDIT) {
        return block;
      }

      const args = getToolCallArgumentsObject(toolCall);
      const oldText = getRequiredEditArgument(args, "oldText", toolCall.id);
      const newText = getRequiredEditArgument(args, "newText", toolCall.id);

      if (oldText === PRUNED_EDIT_ARGUMENT_MARKER && newText === PRUNED_EDIT_ARGUMENT_MARKER) {
        return block;
      }

      changed = true;
      summary.callsPruned += 1;
      const oldBytes = Buffer.byteLength(oldText, "utf8");
      const newBytes = Buffer.byteLength(newText, "utf8");
      const markerBytes = Buffer.byteLength(PRUNED_EDIT_ARGUMENT_MARKER, "utf8") * 2;
      summary.bytesRemoved += Math.max(0, oldBytes + newBytes - markerBytes);
      editCallsById.set(toolCall.id, { oldText, newText });

      return {
        ...toolCall,
        arguments: {
          ...args,
          oldText: PRUNED_EDIT_ARGUMENT_MARKER,
          newText: PRUNED_EDIT_ARGUMENT_MARKER,
        },
      };
    });

    if (changed) {
      replacePrunedMessageOrThrow(
        replaceMessageById,
        entry.id,
        { ...assistant, content: nextContent },
        "edit tool call",
      );
    }
  }

  if (editCallsById.size === 0) {
    return summary;
  }

  for (const entry of historyEntries) {
    const message = entry.message;
    if (message.role !== "toolResult") {
      continue;
    }

    const toolResult = message as ToolResultMessage;
    if (toolResult.toolName !== TOOL_NAME_EDIT) {
      continue;
    }
    if (toolResult.isError) {
      continue;
    }

    const callDiff = editCallsById.get(toolResult.toolCallId);
    if (!callDiff) {
      continue;
    }

    const inspection = inspectToolResultContent(toolResult);
    if (inspection.firstText?.startsWith(PRUNED_EDIT_RESULT_PREFIX)) {
      continue;
    }

    const prunedText = buildPrunedEditToolResult(callDiff);
    const prunedResult: ToolResultMessage = {
      ...toolResult,
      content: [{ type: "text", text: prunedText }],
    };
    replacePrunedMessageOrThrow(replaceMessageById, entry.id, prunedResult, "edit tool result");
    summary.prunedToolResults.push({ toolCallId: prunedResult.toolCallId, content: prunedText });
    summary.resultsPruned += 1;
  }

  return summary;
}

function replacePrunedMessageOrThrow(
  replaceMessageById: (historyEntryId: string, message: Message) => boolean,
  historyEntryId: string,
  message: Message,
  label: string,
): void {
  if (!replaceMessageById(historyEntryId, message)) {
    throw new Error(`failed to replace pruned ${label} '${historyEntryId}'`);
  }
}

function getAssistantContentOrThrow(
  assistant: AssistantMessage,
  context: "pruning edit tool calls" | "building smart prune prompt",
): AssistantMessage["content"] {
  if (!Array.isArray(assistant.content)) {
    throw new Error(`invalid assistant message content while ${context}`);
  }

  return assistant.content;
}

function getToolCallArgumentsObject(toolCall: ToolCall): Record<string, unknown> {
  const { arguments: argumentsValue } = toolCall;
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error(`invalid edit tool call arguments (tool_call_id=${toolCall.id})`);
  }

  return argumentsValue as Record<string, unknown>;
}

function getRequiredEditArgument(
  args: Record<string, unknown>,
  key: "oldText" | "newText",
  toolCallId: string,
): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`missing edit argument '${key}' (tool_call_id=${toolCallId})`);
  }

  return value;
}

function buildPrunedEditToolResult(diff: EditPruneCallDiff): string {
  const diffText = buildPrunedEditDiff(diff.oldText, diff.newText);
  return `${PRUNED_EDIT_RESULT_PREFIX}\n${diffText}`;
}

function buildPrunedEditDiff(oldText: string, newText: string): string {
  const diff = buildLineDiff(oldText, newText);
  if (diff.added === 0 && diff.removed === 0) {
    return "(No textual changes)";
  }

  const collapsed = collapseLongUnchangedDiffRuns({
    diffLines: diff.lines,
    maxUnchangedLines: PRUNE_EDIT_UNCHANGED_CONTEXT_LINES,
  });

  return collapsed.length > 0 ? collapsed.join("\n") : "(No textual changes)";
}

function buildPrunedToolResultNotice(toolResult: ToolResultMessage, bytes: number): string {
  const tokenEstimate = formatTokenEstimate(bytes);
  return `${PRUNED_TOOL_RESULT_PREFIX} ${toolResult.toolName} output removed (${tokenEstimate}). Re-run the command if needed.`;
}

function inspectToolResultContent(toolResult: ToolResultMessage): ToolResultContentInspection {
  const parts: string[] = [];
  let textBytes = 0;
  let hasImage = false;
  let firstText: string | undefined;

  for (const block of toolResult.content) {
    if (block.type === "text") {
      if (firstText === undefined) {
        firstText = block.text;
      }
      parts.push(block.text);
      textBytes += Buffer.byteLength(block.text, "utf8");
      continue;
    }

    if (block.type === "image") {
      hasImage = true;
    }
  }

  return {
    text: parts.join("\n").trimEnd(),
    textBytes,
    hasImage,
    firstText,
  };
}

function buildSmartPrunePrompt(args: {
  history: readonly Message[];
  targetTokens: number;
  guidance?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Target pruning token budget: ${args.targetTokens}`);
  lines.push(
    [
      "The budget is the total tokens to prune.",
      "It is better to slightly exceed it than to be significantly below it.",
    ].join(" "),
  );
  lines.push(
    'Return only JSON: {"prune":[...]} with tool_call_id values from the conversation history.',
  );
  lines.push("Only include tool_call_id values for bash tool results.");
  if (args.guidance?.trim()) {
    lines.push(`Guidance (prioritize this): ${args.guidance.trim()}`);
  } else {
    lines.push("Guidance: (none provided, use your best judgment)");
  }
  lines.push("");
  lines.push("Conversation history:");
  lines.push("<conversation>");
  lines.push(...formatPruneConversationHistory(args.history));
  lines.push("</conversation>");
  return lines.join("\n");
}

function formatPruneConversationHistory(history: readonly Message[]): string[] {
  const lines: string[] = [];

  for (const message of history) {
    if (message.role === "user") {
      lines.push("<user>");
      appendPruneContentLines(lines, message.content);
      lines.push("</user>");
      lines.push("");
      continue;
    }

    if (message.role === "assistant") {
      lines.push("<assistant>");
      const assistant = message as AssistantMessage;
      const assistantContent = getAssistantContentOrThrow(assistant, "building smart prune prompt");

      for (const block of assistantContent) {
        if (block.type === "text") {
          appendPruneText(lines, block.text);
          continue;
        }

        if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          lines.push(buildPruneToolCallTag(toolCall));
        }
      }
      lines.push("</assistant>");
      lines.push("");
      continue;
    }

    if (message.role === "toolResult") {
      const toolResult = message as ToolResultMessage;
      lines.push(...buildPruneToolResultLines(toolResult));
      lines.push("");
    }
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function appendPruneContentLines(lines: string[], content: Message["content"]): void {
  if (typeof content === "string") {
    appendPruneText(lines, content);
    return;
  }

  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (block.type === "text") {
      appendPruneText(lines, block.text);
    }
  }
}

function appendPruneText(lines: string[], text: string): void {
  const escaped = escapeXml(text);
  const parts = escaped.split(/\r?\n/);
  for (const part of parts) {
    lines.push(part);
  }
}

function buildPruneToolCallTag(toolCall: ToolCall): string {
  const name = escapeXmlAttribute(toolCall.name);
  const id = escapeXmlAttribute(toolCall.id);
  const argsValue = JSON.stringify(toolCall.arguments);
  const args = escapeXmlAttribute(argsValue);
  return `<tool-call name="${name}" id="${id}" args="${args}" />`;
}

function buildPruneToolResultLines(toolResult: ToolResultMessage): string[] {
  const lines: string[] = [];
  const name = escapeXmlAttribute(toolResult.toolName);
  const toolCallId = escapeXmlAttribute(toolResult.toolCallId);
  const inspection = inspectToolResultContent(toolResult);

  if (inspection.hasImage) {
    lines.push(`<tool-result name="${name}" tool_call_id="${toolCallId}">`);
    lines.push("<preview>[image omitted]</preview>");
    lines.push("</tool-result>");
    return lines;
  }

  const preview = buildPruneToolResultPreview(inspection.text);
  lines.push(
    `<tool-result name="${name}" tool_call_id="${toolCallId}" total_tokens="${preview.totalTokens}">`,
  );
  lines.push(`<preview max_tokens="${PRUNE_PREVIEW_MAX_TOKENS}">`);
  lines.push(...preview.lines);
  lines.push("</preview>");
  lines.push("</tool-result>");
  return lines;
}

function buildPruneToolResultPreview(text: string): {
  lines: string[];
  totalTokens: number;
} {
  const normalized = text.trimEnd();
  const totalBytes = Buffer.byteLength(normalized, "utf8");
  const totalTokens = bytesToTokens(totalBytes);

  if (totalTokens <= PRUNE_PREVIEW_MAX_TOKENS) {
    const escaped = escapeXml(normalized);
    const lines = escaped ? escaped.split(/\r?\n/) : [""];
    return { lines, totalTokens };
  }

  const head = truncateToBytesFromStart(normalized, tokensToBytes(PRUNE_PREVIEW_MAX_TOKENS));
  const remainingTokens = Math.max(0, totalTokens - PRUNE_PREVIEW_MAX_TOKENS);
  const suffix = `...${remainingTokens} more tokens...`;
  const previewText =
    head.endsWith("\n") || head === "" ? `${head}${suffix}` : `${head}\n${suffix}`;
  const escaped = escapeXml(previewText);
  const lines = escaped ? escaped.split(/\r?\n/) : [""];
  return { lines, totalTokens };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
