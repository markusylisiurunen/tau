import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { CoreSession } from "../../core/session/core_session.js";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../../core/tools/tool_names.js";
import { buildLineDiff, collapseLongUnchangedDiffRuns } from "../../core/utils/line_diff.js";
import { bytesToTokens, formatTokenEstimate, tokensToBytes } from "../../core/utils/token.js";
import { truncateToBytesFromStart } from "../../core/utils/truncate.js";

const DEFAULT_PRUNE_FRACTION = 0.25;
const PRUNED_TOOL_RESULT_PREFIX = "[tool result pruned]";
const PRUNED_EDIT_RESULT_PREFIX = "[tool result pruned] edit diff";
const PRUNED_EDIT_ARGUMENT_MARKER = "[content pruned]";
const PRUNE_EDIT_UNCHANGED_CONTEXT_LINES = 4;
const PRUNE_PREVIEW_MAX_TOKENS = 512;
const PRUNE_MAX_OVERAGE_RATIO = 0.1;

type ToolResultPruneCandidate = {
  index: number;
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

export type MaintenanceTaskOutcome<T> = {
  aborted: boolean;
  value?: T;
  error?: unknown;
};

export type MaintenanceTaskRunner = <T>(
  task: (signal: AbortSignal) => Promise<T>,
) => Promise<MaintenanceTaskOutcome<T>>;

type SessionMaintenanceView = {
  addSystemMessage: (text: string, kind: "success" | "error" | "warn") => void;
  handleToolUiEvent: (event: { type: "tool_pruned"; toolCallId: string; content: string }) => void;
};

export interface SessionMaintenanceServiceOptions {
  engine: CoreSession;
  view: SessionMaintenanceView;
  runStreamingTask: MaintenanceTaskRunner;
  applyCompactedHistoryUi: (compactionMessage: string) => void;
  requestSmartPruneSelection: (prompt: string, signal?: AbortSignal) => Promise<string[]>;
}

export class SessionMaintenanceService {
  private readonly engine: CoreSession;
  private readonly view: SessionMaintenanceView;
  private readonly runStreamingTask: MaintenanceTaskRunner;
  private readonly applyCompactedHistoryUi: (compactionMessage: string) => void;
  private readonly requestSmartPruneSelection: (
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<string[]>;

  constructor(options: SessionMaintenanceServiceOptions) {
    this.engine = options.engine;
    this.view = options.view;
    this.runStreamingTask = options.runStreamingTask;
    this.applyCompactedHistoryUi = options.applyCompactedHistoryUi;
    this.requestSmartPruneSelection = options.requestSmartPruneSelection;
  }

  async compactSummaryOnly(guidance?: string): Promise<void> {
    this.view.addSystemMessage("summarizing session...", "success");
    const outcome = await this.runStreamingTask(async (signal) => {
      const result = await this.engine.compact({
        mode: "only-summary",
        guidance,
        signal,
      });
      this.applyCompactedHistoryUi(result.compactionMessage);
      this.view.addSystemMessage(
        "session compacted. previous context has been summarized.",
        "success",
      );
    });

    if (outcome.error && !outcome.aborted) {
      this.handleCompactionError(outcome.error);
    }
  }

  async compactSummaryAndLast(guidance?: string): Promise<void> {
    this.view.addSystemMessage("summarizing session...", "success");
    const outcome = await this.runStreamingTask(async (signal) => {
      const result = await this.engine.compact({
        mode: "with-last-assistant",
        guidance,
        signal,
      });
      this.applyCompactedHistoryUi(result.compactionMessage);
      const successText = result.includedLastAssistant
        ? "session compacted. previous context and last assistant message have been included."
        : "session compacted. previous context has been summarized.";
      this.view.addSystemMessage(successText, "success");
    });

    if (outcome.error && !outcome.aborted) {
      this.handleCompactionError(outcome.error);
    }
  }

  pruneToolResults(strategy: "earliest" | "largest", extra?: string): void {
    const fraction = this.parsePruneFraction(extra);
    if (fraction === null) {
      this.view.addSystemMessage("invalid prune fraction. use a number between 0 and 1.", "error");
      return;
    }

    if (fraction === 0) {
      this.view.addSystemMessage("prune fraction is 0, nothing to prune.", "warn");
      return;
    }

    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to prune.", "warn");
      return;
    }

    const editSummary = this.pruneEditToolHistory(history);

    const candidates: ToolResultPruneCandidate[] = [];
    let totalTokens = 0;

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "toolResult") continue;
      const toolResult = message as ToolResultMessage;
      if (toolResult.toolName !== TOOL_NAME_BASH) {
        continue;
      }
      const info = this.getToolResultContentInfo(toolResult);
      if (info.firstText?.startsWith(PRUNED_TOOL_RESULT_PREFIX)) {
        continue;
      }
      if (info.hasImage) {
        continue;
      }
      const tokens = bytesToTokens(info.bytes);
      candidates.push({
        index,
        toolResult,
        bytes: info.bytes,
        tokens,
        order: candidates.length,
      });
      totalTokens += tokens;
    }

    if (candidates.length === 0 || totalTokens === 0) {
      if (this.hasAnyPrunedEditChanges(editSummary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(editSummary), "success");
      } else {
        this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
      }
      return;
    }

    const targetTokens = Math.ceil(totalTokens * fraction);
    if (targetTokens <= 0) {
      if (this.hasAnyPrunedEditChanges(editSummary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(editSummary), "success");
      } else {
        this.view.addSystemMessage("prune fraction is too small to remove anything.", "warn");
      }
      return;
    }

    const ordered =
      strategy === "largest"
        ? [...candidates].sort(
            (a, b) => b.tokens - a.tokens || b.bytes - a.bytes || a.order - b.order,
          )
        : candidates;

    const toPrune: ToolResultPruneCandidate[] = [];
    let prunedTokens = 0;
    let prunedBytes = 0;

    for (const candidate of ordered) {
      if (prunedTokens >= targetTokens) break;
      toPrune.push(candidate);
      prunedTokens += candidate.tokens;
      prunedBytes += candidate.bytes;
    }

    if (toPrune.length === 0) {
      if (this.hasAnyPrunedEditChanges(editSummary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(editSummary), "success");
      } else {
        this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
      }
      return;
    }

    for (const candidate of toPrune) {
      const noticeText = this.buildPrunedToolResultNotice(candidate.toolResult, candidate.bytes);
      const prunedResult: ToolResultMessage = {
        ...candidate.toolResult,
        content: [{ type: "text", text: noticeText }],
      };
      this.engine.replaceMessage(candidate.index, prunedResult);
      this.emitToolResultPrunedUiEvent(prunedResult.toolCallId, noticeText);
    }

    this.view.addSystemMessage(
      this.buildPruneSummaryMessage(editSummary, toPrune.length, prunedBytes),
      "success",
    );
  }

  async pruneToolResultsSmart(extra?: string): Promise<void> {
    const parsed = this.parsePruneFractionAndGuidance(extra);
    if (parsed.fraction === null) {
      this.view.addSystemMessage("invalid prune fraction. use a number between 0 and 1.", "error");
      return;
    }

    const fraction = parsed.fraction;
    if (fraction === 0) {
      this.view.addSystemMessage("prune fraction is 0, nothing to prune.", "warn");
      return;
    }

    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to prune.", "warn");
      return;
    }

    let editSummary: EditPruneSummary | undefined;
    const getEditSummary = (): EditPruneSummary => {
      if (!editSummary) {
        editSummary = this.pruneEditToolHistory(history);
      }
      return editSummary;
    };

    const candidates: ToolResultPruneCandidate[] = [];
    let totalTokens = 0;

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "toolResult") continue;
      const toolResult = message as ToolResultMessage;
      if (toolResult.toolName !== TOOL_NAME_BASH) {
        continue;
      }
      const details = this.getToolResultContentDetails(toolResult);
      if (details.firstText?.startsWith(PRUNED_TOOL_RESULT_PREFIX)) {
        continue;
      }
      if (details.hasImage) {
        continue;
      }
      const tokens = bytesToTokens(details.bytes);
      candidates.push({
        index,
        toolResult,
        bytes: details.bytes,
        tokens,
        order: candidates.length,
      });
      totalTokens += tokens;
    }

    if (candidates.length === 0 || totalTokens === 0) {
      const summary = getEditSummary();
      if (this.hasAnyPrunedEditChanges(summary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
      } else {
        this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
      }
      return;
    }

    const targetTokens = Math.ceil(totalTokens * fraction);
    if (targetTokens <= 0) {
      const summary = getEditSummary();
      if (this.hasAnyPrunedEditChanges(summary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
      } else {
        this.view.addSystemMessage("prune fraction is too small to remove anything.", "warn");
      }
      return;
    }

    this.view.addSystemMessage("sampling prune candidates...", "success");

    const prompt = this.buildSmartPrunePrompt({
      history,
      targetTokens,
      guidance: parsed.guidance,
    });

    const selectionOutcome = await this.runStreamingTask(async (signal) => {
      const selection = await this.requestSmartPruneSelection(prompt, signal);
      if (selection.length === 0) {
        const summary = getEditSummary();
        if (this.hasAnyPrunedEditChanges(summary)) {
          this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
        } else {
          this.view.addSystemMessage("model returned no prune candidates.", "warn");
        }
        return;
      }

      const toPrune = this.selectSmartPruneCandidates(selection, candidates, targetTokens);
      if (toPrune.length === 0) {
        const summary = getEditSummary();
        if (this.hasAnyPrunedEditChanges(summary)) {
          this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
        } else {
          this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
        }
        return;
      }

      const summary = getEditSummary();
      let prunedBytes = 0;
      for (const candidate of toPrune) {
        prunedBytes += candidate.bytes;
        const noticeText = this.buildPrunedToolResultNotice(candidate.toolResult, candidate.bytes);
        const prunedResult: ToolResultMessage = {
          ...candidate.toolResult,
          content: [{ type: "text", text: noticeText }],
        };
        this.engine.replaceMessage(candidate.index, prunedResult);
        this.emitToolResultPrunedUiEvent(prunedResult.toolCallId, noticeText);
      }

      this.view.addSystemMessage(
        this.buildPruneSummaryMessage(summary, toPrune.length, prunedBytes),
        "success",
      );
    });

    if (selectionOutcome.error && !selectionOutcome.aborted) {
      this.view.addSystemMessage(
        `prune failed: ${(selectionOutcome.error as Error).message}`,
        "error",
      );
    }
  }

  private handleCompactionError(err: unknown): void {
    const message = (err as Error).message || "compaction failed";
    if (message === "no conversation to compact.") {
      this.view.addSystemMessage(message, "warn");
      return;
    }
    this.view.addSystemMessage(`compact failed: ${message}`, "error");
  }

  private parsePruneFraction(extra?: string): number | null {
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

  private parsePruneFractionAndGuidance(extra?: string): {
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

  private hasAnyPrunedEditChanges(summary: EditPruneSummary): boolean {
    return summary.callsPruned > 0 || summary.resultsPruned > 0;
  }

  private buildPruneSummaryMessage(
    editSummary: EditPruneSummary,
    bashResultsPruned: number = 0,
    bashBytesPruned: number = 0,
  ): string {
    const editSummaryText = this.formatPrunedEditSummary(editSummary);

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

  private formatPrunedEditSummary(summary: EditPruneSummary): string {
    if (!this.hasAnyPrunedEditChanges(summary)) {
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

  private pruneEditToolHistory(history: readonly Message[]): EditPruneSummary {
    const summary: EditPruneSummary = {
      callsPruned: 0,
      resultsPruned: 0,
      bytesRemoved: 0,
    };
    const editCallsById = new Map<string, EditPruneCallDiff>();

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "assistant") {
        continue;
      }

      const assistant = message as AssistantMessage;
      let changed = false;
      const nextContent = assistant.content.map((block) => {
        if (typeof block === "string" || block.type !== "toolCall") {
          return block;
        }

        const toolCall = block as ToolCall;
        if (toolCall.name !== TOOL_NAME_EDIT) {
          return block;
        }

        const args = this.getToolCallArgumentsObject(toolCall.arguments);
        if (!args) {
          return block;
        }

        const oldText = typeof args.oldText === "string" ? args.oldText : undefined;
        const newText = typeof args.newText === "string" ? args.newText : undefined;
        if (oldText === undefined || newText === undefined) {
          return block;
        }

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
        this.engine.replaceMessage(index, { ...assistant, content: nextContent });
      }
    }

    if (editCallsById.size === 0) {
      return summary;
    }

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "toolResult") {
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

      const info = this.getToolResultContentInfo(toolResult);
      if (info.firstText?.startsWith(PRUNED_EDIT_RESULT_PREFIX)) {
        continue;
      }

      const prunedText = this.buildPrunedEditToolResult(callDiff);
      const prunedResult: ToolResultMessage = {
        ...toolResult,
        content: [{ type: "text", text: prunedText }],
      };
      this.engine.replaceMessage(index, prunedResult);
      this.emitToolResultPrunedUiEvent(prunedResult.toolCallId, prunedText);
      summary.resultsPruned += 1;
    }

    return summary;
  }

  private getToolCallArgumentsObject(argumentsValue: unknown): Record<string, unknown> | undefined {
    if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
      return argumentsValue as Record<string, unknown>;
    }

    if (typeof argumentsValue !== "string") {
      return undefined;
    }

    try {
      const parsed = JSON.parse(argumentsValue);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private buildPrunedEditToolResult(diff: EditPruneCallDiff): string {
    const diffText = this.buildPrunedEditDiff(diff.oldText, diff.newText);
    return `${PRUNED_EDIT_RESULT_PREFIX}\n${diffText}`;
  }

  private buildPrunedEditDiff(oldText: string, newText: string): string {
    const diff = buildLineDiff(oldText, newText);
    if (diff.added === 0 && diff.removed === 0) {
      return "(no textual changes)";
    }

    const collapsed = collapseLongUnchangedDiffRuns({
      diffLines: diff.lines,
      maxUnchangedLines: PRUNE_EDIT_UNCHANGED_CONTEXT_LINES,
    });

    return collapsed.length > 0 ? collapsed.join("\n") : "(no textual changes)";
  }

  private buildPrunedToolResultNotice(toolResult: ToolResultMessage, bytes: number): string {
    const tokenEstimate = formatTokenEstimate(bytes);
    return `${PRUNED_TOOL_RESULT_PREFIX} ${toolResult.toolName} output removed (${tokenEstimate}). re-run the command if needed.`;
  }

  private emitToolResultPrunedUiEvent(toolCallId: string, content: string): void {
    this.view.handleToolUiEvent({
      type: "tool_pruned",
      toolCallId,
      content,
    });
  }

  private getToolResultContentInfo(toolResult: ToolResultMessage): {
    bytes: number;
    hasImage: boolean;
    firstText?: string;
  } {
    if (typeof toolResult.content === "string") {
      const text = toolResult.content;
      return { bytes: Buffer.byteLength(text, "utf8"), hasImage: false, firstText: text };
    }

    let bytes = 0;
    let hasImage = false;
    let firstText: string | undefined;

    if (!Array.isArray(toolResult.content)) {
      return { bytes, hasImage, firstText };
    }

    for (const block of toolResult.content) {
      if (typeof block === "string") {
        if (firstText === undefined) {
          firstText = block;
        }
        bytes += Buffer.byteLength(block, "utf8");
        continue;
      }

      if (block.type === "text") {
        const text = block.text ?? "";
        if (firstText === undefined) {
          firstText = text;
        }
        bytes += Buffer.byteLength(text, "utf8");
        continue;
      }

      if (block.type === "image") {
        hasImage = true;
      }
    }

    return { bytes, hasImage, firstText };
  }

  private getToolResultContentDetails(toolResult: ToolResultMessage): {
    text: string;
    bytes: number;
    hasImage: boolean;
    firstText?: string;
  } {
    if (typeof toolResult.content === "string") {
      const text = (toolResult.content as string).trimEnd();
      return {
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        hasImage: false,
        firstText: toolResult.content as string,
      };
    }

    const parts: string[] = [];
    let hasImage = false;
    let firstText: string | undefined;

    if (!Array.isArray(toolResult.content)) {
      return { text: "", bytes: 0, hasImage, firstText };
    }

    for (const block of toolResult.content) {
      if (typeof block === "string") {
        if (firstText === undefined) {
          firstText = block;
        }
        parts.push(block);
        continue;
      }

      if (block.type === "text") {
        const text = block.text ?? "";
        if (firstText === undefined) {
          firstText = text;
        }
        parts.push(text);
        continue;
      }

      if (block.type === "image") {
        hasImage = true;
      }
    }

    const text = parts.join("\n").trimEnd();
    return {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      hasImage,
      firstText,
    };
  }

  private buildSmartPrunePrompt(args: {
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
    lines.push(...this.formatPruneConversationHistory(args.history));
    lines.push("</conversation>");
    return lines.join("\n");
  }

  private formatPruneConversationHistory(history: readonly Message[]): string[] {
    const lines: string[] = [];

    for (const message of history) {
      if (message.role === "user") {
        lines.push("<user>");
        this.appendPruneContentLines(lines, message.content);
        lines.push("</user>");
        lines.push("");
        continue;
      }

      if (message.role === "assistant") {
        lines.push("<assistant>");
        const assistant = message as AssistantMessage;
        for (const block of assistant.content) {
          if (typeof block === "string") {
            this.appendPruneText(lines, block);
            continue;
          }

          if (block.type === "text") {
            this.appendPruneText(lines, block.text ?? "");
            continue;
          }

          if (block.type === "toolCall") {
            const toolCall = block as ToolCall;
            lines.push(this.buildPruneToolCallTag(toolCall));
          }
        }
        lines.push("</assistant>");
        lines.push("");
        continue;
      }

      if (message.role === "toolResult") {
        const toolResult = message as ToolResultMessage;
        lines.push(...this.buildPruneToolResultLines(toolResult));
        lines.push("");
      }
    }

    if (lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines;
  }

  private appendPruneContentLines(lines: string[], content: Message["content"]): void {
    if (typeof content === "string") {
      this.appendPruneText(lines, content);
      return;
    }

    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (typeof block === "string") {
        this.appendPruneText(lines, block);
      } else if (block.type === "text") {
        this.appendPruneText(lines, block.text ?? "");
      }
    }
  }

  private appendPruneText(lines: string[], text: string): void {
    const escaped = this.escapeXml(text);
    const parts = escaped.split(/\r?\n/);
    for (const part of parts) {
      lines.push(part);
    }
  }

  private buildPruneToolCallTag(toolCall: ToolCall): string {
    const name = this.escapeXmlAttribute(toolCall.name);
    const id = this.escapeXmlAttribute(toolCall.id);
    const argsValue =
      typeof toolCall.arguments === "string"
        ? toolCall.arguments
        : JSON.stringify(toolCall.arguments ?? {});
    const args = this.escapeXmlAttribute(argsValue);
    return `<tool-call name="${name}" id="${id}" args="${args}" />`;
  }

  private buildPruneToolResultLines(toolResult: ToolResultMessage): string[] {
    const lines: string[] = [];
    const name = this.escapeXmlAttribute(toolResult.toolName);
    const toolCallId = this.escapeXmlAttribute(toolResult.toolCallId);
    const details = this.getToolResultContentDetails(toolResult);

    if (details.hasImage) {
      lines.push(`<tool-result name="${name}" tool_call_id="${toolCallId}">`);
      lines.push("<preview>[image omitted]</preview>");
      lines.push("</tool-result>");
      return lines;
    }

    const preview = this.buildPruneToolResultPreview(details.text);
    lines.push(
      `<tool-result name="${name}" tool_call_id="${toolCallId}" total_tokens="${preview.totalTokens}">`,
    );
    lines.push(`<preview max_tokens="${PRUNE_PREVIEW_MAX_TOKENS}">`);
    lines.push(...preview.lines);
    lines.push("</preview>");
    lines.push("</tool-result>");
    return lines;
  }

  private buildPruneToolResultPreview(text: string): {
    lines: string[];
    totalTokens: number;
  } {
    const normalized = text.trimEnd();
    const totalBytes = Buffer.byteLength(normalized, "utf8");
    const totalTokens = bytesToTokens(totalBytes);

    if (totalTokens <= PRUNE_PREVIEW_MAX_TOKENS) {
      const escaped = this.escapeXml(normalized);
      const lines = escaped ? escaped.split(/\r?\n/) : [""];
      return { lines, totalTokens };
    }

    const head = truncateToBytesFromStart(normalized, tokensToBytes(PRUNE_PREVIEW_MAX_TOKENS));
    const remainingTokens = Math.max(0, totalTokens - PRUNE_PREVIEW_MAX_TOKENS);
    const suffix = `…${remainingTokens} more tokens…`;
    const previewText =
      head.endsWith("\n") || head === "" ? `${head}${suffix}` : `${head}\n${suffix}`;
    const escaped = this.escapeXml(previewText);
    const lines = escaped ? escaped.split(/\r?\n/) : [""];
    return { lines, totalTokens };
  }

  private selectSmartPruneCandidates(
    ids: string[],
    candidates: ToolResultPruneCandidate[],
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

  private escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escapeXmlAttribute(text: string): string {
    return this.escapeXml(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
}
