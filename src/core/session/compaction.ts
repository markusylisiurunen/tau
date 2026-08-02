import { Buffer } from "node:buffer";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  buildCompactionUserMessage,
  formatHistoryForCompaction,
  truncateToolRecoveryResults,
} from "../utils/compact.js";
import { extractAssistantText } from "../utils/messages.js";
import { bytesToTokens } from "../utils/token.js";
import { truncateForTokens } from "../utils/truncate.js";
import {
  formatTauUserText,
  getSummaryCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  hasToolRecoveryMetadata,
  stripTauUserMetadata,
} from "../utils/user_metadata.js";
import type { AutoCompactionArchivePaths } from "./auto_compaction_archive.js";

export type CompactionHistoryEntry = {
  id: string;
  message: Message;
};

export type SessionCompactionMode = "only-summary" | "with-last-assistant";

export type PreservedUserMessage = {
  id: string;
  text: string;
};

type UserMessageCandidate = PreservedUserMessage & {
  source: "conversation" | "previous-preserved";
};

type CompactionPromptPreparation = {
  previousSummary?: string;
  formattedHistory: string;
  userMessageCandidates: UserMessageCandidate[];
};

export type SessionCompactionPreparation = CompactionPromptPreparation & {
  messagesToSummarize: Message[];
};

export type SessionCompactionMessageResult = {
  compactionMessage: string;
  includedLastAssistant: boolean;
};

export type ParsedCompactionSummary = {
  summary: string;
  preservedUserMessages: PreservedUserMessage[];
};

const PRESERVED_USER_MESSAGE_MAX_TOKENS = 20_000;
const RETAINED_TOOL_RESULT_MAX_TOKENS = 8_192;
const PRESERVED_USER_MESSAGE_IDS_OPEN_TAG = "<preserved-user-message-ids>";
const PRESERVED_USER_MESSAGE_IDS_CLOSE_TAG = "</preserved-user-message-ids>";

export type AutoCompactionCutType = "turn-boundary" | "split-turn";

export type AutoCompactionPreparation = CompactionPromptPreparation & {
  retainedEntries: CompactionHistoryEntry[];
  cutType: AutoCompactionCutType;
};

export const COMPACTION_SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context compaction assistant. Your output will replace the conversation history for another assistant. Do not continue the conversation. Do not answer any conversation questions. Only output a structured handoff summary followed by the required preserved user message id block.";

const COMPACTION_SUMMARIZATION_PROMPT = `The messages above are a conversation to compact. Create an information-dense context checkpoint summary that will replace the full conversation history. Another assistant should be able to continue the session from this summary as if the original conversation were still available.

If a [System prompt] block is present, use it as context for interpreting the conversation. Do not summarize it as part of the conversation history.

Use this structure as a strong default, not a rigid form. Preserve the same continuity-critical concerns, but reorganize, combine, omit, or add sections when another structure would produce a clearer handoff. Project-specific sections and concise prose are allowed. The <preserved-user-message-ids> block remains required and must appear exactly once at the end.

## Goal
[What the user is currently trying to accomplish. If the goal changed, briefly note the shift.]

## Constraints & Preferences
- [Constraints, preferences, or requirements from the user]
- [Use "(none)" when nothing explicit exists]

## Progress
### Done
- [x] [Completed tasks and confirmed outcomes]

### In Progress
- [ ] [Current work in progress]

### Blocked
- [Open blockers, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next action]

## Critical Context
- [Concrete details needed to resume: file paths, function names, commands, errors, test/build status, assumptions]

<preserved-user-message-ids>
[JSON array of history entry id strings for user messages to copy verbatim into the compaction summary. Use [] when no candidate should be copied verbatim.]
</preserved-user-message-ids>

Rules:
- Preserve as much continuity-critical context as possible while removing tokens.
- Optimize for continuing the work, not retrospectively describing the conversation.
- The Goal section must preserve the user's current objective and any still-relevant original request, even if it appears early in the conversation.
- Keep each section information-dense and focused; do not omit useful details solely for brevity.
- When unsure whether a detail may matter later, preserve it in compact form.
- Preserve the current state of the work: files touched, commands run, test/build status, known failures, unverified assumptions, and pending validation.
- Distinguish attempted work from confirmed outcomes.
- If goals evolved over time, capture the current goal and briefly note the change.
- Collapse tangents, retries, and pleasantries unless they materially affect decisions, blockers, or next steps.
- Select preserved user message ids only from <user-message-candidates>. The candidates with source "conversation" are identified inline in <conversation> by matching [User id="..."] markers. Select user messages whose exact wording is likely needed to continue, such as standing goals, constraints, corrections, explicit instructions, and recent actionable requests. Omit resolved, repetitive, superseded, or conversational messages. Keep the selected messages under roughly 20,000 tokens total.
- Preserve exact file paths, function names, commands, and error messages.
- Treat the suggested headings as a checklist, not a form to fill mechanically. Add project-specific sections, combine or omit empty subsections, and use prose or tables when they communicate the handoff more clearly.`;

const COMPACTION_UPDATE_SUMMARIZATION_PROMPT = `The messages above are new conversation messages to incorporate into the existing summary in <previous-summary> tags. The updated summary will replace the prior summary plus these new messages as the session's continuity context.

If a [System prompt] block is present, use it as context for interpreting the new conversation messages. Do not summarize it as part of the conversation history.

Update the existing structured summary with these rules:
- Preserve all still-relevant information from the previous summary.
- Add new progress, decisions, and context from the new messages.
- Move items from In Progress to Done when completed.
- Update Next Steps based on the current state.
- Remove only information that is clearly obsolete, superseded, or irrelevant to continuing the session.

Use the previous summary's structure when it remains clear, but reorganize it when the conversation has changed enough that another structure would produce a better handoff. Preserve the same continuity-critical concerns. You may combine, omit, or add sections, use project-specific headings, and mix concise prose with lists. The <preserved-user-message-ids> block remains required and must appear exactly once at the end.

## Goal
[Preserve and extend goals as needed. If the goal shifted, reflect the latest goal and note the change briefly.]

## Constraints & Preferences
- [Preserve and extend constraints]

## Progress
### Done
- [x] [Previously done and newly completed]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Updated ordered actions]

## Critical Context
- [Concrete details needed to resume: file paths, function names, commands, errors, test/build status, assumptions]

<preserved-user-message-ids>
[JSON array of history entry id strings for user messages to copy verbatim into the compaction summary. Use [] when no candidate should be copied verbatim.]
</preserved-user-message-ids>

Rules:
- Preserve as much continuity-critical context as possible while removing tokens.
- Optimize for continuing the work, not retrospectively describing the conversation.
- The Goal section must preserve the user's current objective and any still-relevant original request, even if it appears early in the conversation.
- Keep each section information-dense and focused; do not omit useful details solely for brevity.
- When unsure whether a detail may matter later, preserve it in compact form.
- Preserve the current state of the work: files touched, commands run, test/build status, known failures, unverified assumptions, and pending validation.
- Distinguish attempted work from confirmed outcomes.
- If goals evolved over time, capture the current goal and briefly note the change.
- Collapse tangents, retries, and pleasantries unless they materially affect decisions, blockers, or next steps.
- Select preserved user message ids only from <user-message-candidates>. The candidates with source "conversation" are identified inline in <conversation> by matching [User id="..."] markers. Select user messages whose exact wording is likely needed to continue, such as standing goals, constraints, corrections, explicit instructions, and recent actionable requests. Omit resolved, repetitive, superseded, or conversational messages. Keep the selected messages under roughly 20,000 tokens total.
- Preserve exact file paths, function names, commands, and error messages.
- Treat the suggested headings as a checklist, not a form to fill mechanically. Add project-specific sections, combine or omit empty subsections, and use prose or tables when they communicate the handoff more clearly.`;

export function prepareSessionCompaction(
  entries: readonly CompactionHistoryEntry[],
  options: { systemPrompt: string },
): SessionCompactionPreparation | undefined {
  const latestCompaction = findLatestCompactionEntry(entries);
  const entriesToSummarize = entries
    .slice(latestCompaction.index + 1)
    .filter((entry) => !hasAutoCompactionContinuationMetadata(entry.message));
  const messagesToSummarize = entriesToSummarize.map((entry) => entry.message);
  const historyEntryIds = buildHistoryEntryIdMap(entriesToSummarize);
  const formattedConversation = formatHistoryForCompaction(messagesToSummarize, {
    historyEntryIds,
  });
  if (!formattedConversation) {
    return undefined;
  }
  const formattedHistory = formatHistoryForCompaction(messagesToSummarize, {
    systemPrompt: options.systemPrompt,
    historyEntryIds,
  });

  return {
    previousSummary: latestCompaction.summary,
    messagesToSummarize,
    formattedHistory,
    userMessageCandidates: collectUserMessageCandidates(
      entriesToSummarize,
      latestCompaction.preservedUserMessages,
    ),
  };
}

export function buildSessionCompactionPrompt(args: {
  preparation: CompactionPromptPreparation;
  guidance?: string;
}): string {
  const { preparation, guidance } = args;
  let summaryPrompt = `<conversation>\n${preparation.formattedHistory}\n</conversation>\n\n`;
  if (preparation.previousSummary?.trim()) {
    summaryPrompt += `<previous-summary>\n${preparation.previousSummary.trim()}\n</previous-summary>\n\n`;
  }
  if (preparation.userMessageCandidates.length > 0) {
    summaryPrompt += `<user-message-candidates>\n${formatUserMessageCandidates(preparation.userMessageCandidates)}\n</user-message-candidates>\n\n`;
  }

  summaryPrompt += preparation.previousSummary
    ? COMPACTION_UPDATE_SUMMARIZATION_PROMPT
    : COMPACTION_SUMMARIZATION_PROMPT;

  const guidanceBlock = guidance?.trim();
  if (guidanceBlock) {
    summaryPrompt += `\n\nAdditional focus: ${guidanceBlock}`;
  }

  return summaryPrompt;
}

export function buildSessionCompactionMessage(args: {
  summary: string;
  mode: SessionCompactionMode;
  messagesToSummarize: readonly Message[];
  preservedUserMessages: readonly PreservedUserMessage[];
}): SessionCompactionMessageResult {
  const lastAssistantMessage =
    args.mode === "with-last-assistant"
      ? extractLastAssistantMessage(args.messagesToSummarize)
      : undefined;
  const summary = buildCompactionSummary({
    summary: args.summary,
    preservedUserMessages: args.preservedUserMessages,
  });

  return {
    compactionMessage: buildCompactionUserMessage({
      summary,
      lastAssistantMessage,
    }),
    includedLastAssistant: Boolean(lastAssistantMessage),
  };
}

export function buildCompactionSummary(args: {
  summary: string;
  preservedUserMessages: readonly PreservedUserMessage[];
}): string {
  const summary = args.summary.trim();
  if (args.preservedUserMessages.length === 0) {
    return summary;
  }

  const preserved = args.preservedUserMessages
    .map(
      (message) =>
        `<user-message id="${escapeXmlAttribute(message.id)}">\n${message.text}\n</user-message>`,
    )
    .join("\n\n");

  return `${summary}\n\n## Preserved User Messages\nUse these original user messages as verbatim continuity anchors. Treat them as preserved user intent selected from the compacted history by history entry id.\n\n<preserved-user-messages>\n${preserved}\n</preserved-user-messages>`;
}

export function parseCompactionSummaryResponse(args: {
  response: string;
  userMessageCandidates: readonly PreservedUserMessage[];
}): ParsedCompactionSummary {
  const { summary, selectedIds } = extractSelectedUserMessageIds(args.response, {
    requireSelectionBlock: args.userMessageCandidates.length > 0,
  });
  if (!summary) {
    throw new Error("compaction summary response did not include a summary");
  }

  const candidatesById = new Map(
    args.userMessageCandidates.map((message) => [message.id, message] as const),
  );
  const seenIds = new Set<string>();
  const selectedCandidates = selectedIds.map((id) => {
    if (seenIds.has(id)) {
      throw new Error(`compaction summary selected duplicate preserved user message id '${id}'`);
    }
    const candidate = candidatesById.get(id);
    if (!candidate) {
      throw new Error(`compaction summary selected unknown preserved user message id '${id}'`);
    }
    seenIds.add(id);
    return candidate;
  });

  return {
    summary,
    preservedUserMessages: fitPreservedUserMessages(selectedCandidates),
  };
}

function extractSelectedUserMessageIds(
  response: string,
  options: { requireSelectionBlock: boolean },
): { summary: string; selectedIds: string[] } {
  const text = response.trim();
  const start = text.indexOf(PRESERVED_USER_MESSAGE_IDS_OPEN_TAG);
  if (start < 0) {
    if (options.requireSelectionBlock) {
      throw new Error("compaction summary response did not include preserved user message ids");
    }
    return { summary: text, selectedIds: [] };
  }

  const contentStart = start + PRESERVED_USER_MESSAGE_IDS_OPEN_TAG.length;
  const end = text.indexOf(PRESERVED_USER_MESSAGE_IDS_CLOSE_TAG, contentStart);
  if (end < 0) {
    throw new Error("compaction summary response did not close preserved user message ids");
  }
  if (text.indexOf(PRESERVED_USER_MESSAGE_IDS_OPEN_TAG, contentStart) >= 0) {
    throw new Error(
      "compaction summary response included multiple preserved user message id blocks",
    );
  }

  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end + PRESERVED_USER_MESSAGE_IDS_CLOSE_TAG.length).trimStart();
  const summary = [before, after].filter(Boolean).join("\n\n").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(contentStart, end).trim());
  } catch (error) {
    throw new Error(`invalid preserved user message id selection: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error("invalid preserved user message id selection: expected a JSON string array");
  }

  return { summary, selectedIds: parsed };
}

function fitPreservedUserMessages(
  candidates: readonly PreservedUserMessage[],
): PreservedUserMessage[] {
  const tokenCounts = candidates.map((candidate) => estimateTextTokens(candidate.text));
  const totalTokens = tokenCounts.reduce((total, tokens) => total + tokens, 0);
  if (totalTokens <= PRESERVED_USER_MESSAGE_MAX_TOKENS) {
    return candidates.map((candidate) => ({ id: candidate.id, text: candidate.text }));
  }

  const targets = tokenCounts.map((tokens) =>
    Math.max(1, Math.floor((tokens / totalTokens) * PRESERVED_USER_MESSAGE_MAX_TOKENS)),
  );
  let targetTotal = targets.reduce((total, tokens) => total + tokens, 0);
  while (targetTotal > PRESERVED_USER_MESSAGE_MAX_TOKENS) {
    let largestIndex = 0;
    for (let index = 1; index < targets.length; index += 1) {
      if (targets[index]! > targets[largestIndex]!) {
        largestIndex = index;
      }
    }
    if (targets[largestIndex]! <= 1) {
      break;
    }
    targets[largestIndex] = targets[largestIndex]! - 1;
    targetTotal -= 1;
  }

  return candidates.map((candidate, index) => {
    const maxTokens = targets[index]!;
    return {
      id: candidate.id,
      text: truncateForTokens(candidate.text, { maxTokens, strategy: "middle" }).content,
    };
  });
}

function buildHistoryEntryIdMap(
  entries: readonly CompactionHistoryEntry[],
): ReadonlyMap<Message, string> {
  return new Map(entries.map((entry) => [entry.message, entry.id] as const));
}

function isAutoCompactionArchiveEntry(entry: CompactionHistoryEntry): boolean {
  const message = entry.message;
  return !(
    message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted")
  );
}

function collectUserMessageCandidates(
  entries: readonly CompactionHistoryEntry[],
  previousMessages: readonly PreservedUserMessage[],
): UserMessageCandidate[] {
  const candidates = new Map<string, UserMessageCandidate>();
  for (const message of previousMessages) {
    candidates.set(message.id, {
      id: message.id,
      text: message.text,
      source: "previous-preserved",
    });
  }

  for (const entry of entries) {
    const text = extractPreservableUserText(entry.message);
    if (!text) {
      continue;
    }
    candidates.set(entry.id, { id: entry.id, text, source: "conversation" });
  }

  return [...candidates.values()];
}

function formatUserMessageCandidates(candidates: readonly UserMessageCandidate[]): string {
  const records = candidates.map((message) => {
    if (message.source === "conversation") {
      return { id: message.id, source: message.source };
    }
    return { id: message.id, source: message.source, text: message.text };
  });
  return JSON.stringify(records, null, 2).replaceAll("<", "\\u003c");
}

function extractPreservableUserText(message: Message): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }
  if (
    getSummaryCompactionMetadataFromMessage(message) ||
    hasAutoCompactionContinuationMetadata(message) ||
    hasToolRecoveryMetadata(message)
  ) {
    return undefined;
  }

  const text = extractUserText(message);
  return text.trim() ? text : undefined;
}

function extractUserText(message: Message): string {
  if (typeof message.content === "string") {
    return stripTauUserMetadata(message.content);
  }

  const parts: string[] = [];
  for (const block of message.content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block.type === "text") {
      parts.push(block.text ?? "");
    }
  }

  return stripTauUserMetadata(parts.join("\n"));
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function estimateTextTokens(text: string): number {
  return Math.max(1, bytesToTokens(Buffer.byteLength(text, "utf8")));
}

function boundRetainedEntry(entry: CompactionHistoryEntry): CompactionHistoryEntry {
  const message = structuredClone(entry.message);
  if (message.role === "user" && hasToolRecoveryMetadata(message)) {
    if (typeof message.content === "string") {
      message.content = truncateToolRecoveryResults(
        message.content,
        RETAINED_TOOL_RESULT_MAX_TOKENS,
      );
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          block.text = truncateToolRecoveryResults(block.text, RETAINED_TOOL_RESULT_MAX_TOKENS);
        }
      }
    }
    return { id: entry.id, message };
  }
  if (message.role !== "toolResult") {
    return { id: entry.id, message };
  }

  const toolResult = message as ToolResultMessage;
  const text = toolResult.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  const truncated = truncateForTokens(text, {
    maxTokens: RETAINED_TOOL_RESULT_MAX_TOKENS,
    strategy: "middle",
  });
  if (!truncated.truncated) {
    return { id: entry.id, message };
  }

  const content: ToolResultMessage["content"] = [];
  let replacedText = false;
  for (const block of toolResult.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replacedText) {
      content.push({ ...block, text: truncated.content });
      replacedText = true;
    }
  }

  return {
    id: entry.id,
    message: { ...toolResult, content },
  };
}

export function prepareAutoCompaction(
  entries: readonly CompactionHistoryEntry[],
  settings: { keepRecentTokens: number; systemPrompt: string },
): AutoCompactionPreparation | undefined {
  const latestCompaction = findLatestCompactionEntry(entries);
  const cut = selectAutoCompactionCut(entries, {
    startIndex: latestCompaction.index + 1,
    keepRecentTokens: settings.keepRecentTokens,
  });
  if (!cut) {
    return undefined;
  }

  const entriesToSummarize = entries
    .slice(latestCompaction.index + 1, cut.startIndex)
    .filter((entry) => !hasAutoCompactionContinuationMetadata(entry.message));
  const messagesToSummarize = entriesToSummarize.map((entry) => entry.message);
  const historyEntryIds = buildHistoryEntryIdMap(
    entriesToSummarize.filter(isAutoCompactionArchiveEntry),
  );
  const formattedConversation = formatHistoryForCompaction(messagesToSummarize, {
    historyEntryIds,
  });
  if (!formattedConversation) {
    return undefined;
  }
  const formattedHistory = formatHistoryForCompaction(messagesToSummarize, {
    systemPrompt: settings.systemPrompt,
    historyEntryIds,
  });

  const retainedEntries = entries
    .slice(cut.startIndex)
    .filter((entry) => !hasAutoCompactionContinuationMetadata(entry.message))
    .map(boundRetainedEntry);
  if (retainedEntries.length === 0) {
    return undefined;
  }

  return {
    previousSummary: latestCompaction.summary,
    retainedEntries,
    cutType: cut.cutType,
    formattedHistory,
    userMessageCandidates: collectUserMessageCandidates(
      entriesToSummarize,
      latestCompaction.preservedUserMessages,
    ),
  };
}

const AUTO_COMPACTION_ARCHIVE_REFERENCE_GUIDANCE = `After compaction, the continuing assistant will receive paths to temporary text and JSON transcripts of the pre-compaction context. Conversation records above that show a history entry id can be recovered from those transcripts by id. The continuing assistant can search the numbered text transcripts first, then inspect the corresponding JSON record when it needs the full archived content.

Keep the summary independently useful. State continuity-critical goals, constraints, decisions, current state, blockers, and next steps directly. When exact or bulky details would be wasteful to reproduce, you may mention the relevant history entry id in ordinary prose so the continuing assistant can retrieve it. This is useful for long tool output, diagnostic logs, exact errors, payloads, and large code excerpts. Use such references sparingly and only for ids shown in the conversation.

Good pattern: "The key failure is a missing RuntimeConfig field; the complete compiler output is in history entry 'HISTORY_ENTRY_ID'."
Bad pattern: "See history entry 'HISTORY_ENTRY_ID' for what happened."`;

export function buildAutoCompactionPrompt(preparation: AutoCompactionPreparation): string {
  const retainedContextGuidance =
    preparation.cutType === "split-turn"
      ? `The retained context will begin in the middle of the latest assistant/tool turn. Add a "## Current Turn Handoff" section that clearly captures:
- the original user request for this turn
- work completed before the retained suffix
- tool state and findings at the cut boundary
- what the first retained message is continuing and what remains unresolved

Place the section wherever it makes the handoff clearest. Preserve earlier session context elsewhere in the summary without duplicating the retained suffix.`
      : "The retained context will include recent messages. Ensure the summary complements that retained context without duplicating unnecessary detail.";
  const boundedRetainedContextGuidance =
    "Individual textual tool results and tool-recovery payloads in the retained context may be middle-truncated above the retention limit. Do not describe the retained context as exact or verbatim. The continuing assistant can recover omitted output through a targeted search of the pre-compaction archive when needed.";

  return buildSessionCompactionPrompt({
    preparation,
    guidance: `${retainedContextGuidance}\n\n${boundedRetainedContextGuidance}\n\n${AUTO_COMPACTION_ARCHIVE_REFERENCE_GUIDANCE}`,
  });
}

export function buildAutoCompactionContinuationMessage(args: {
  cutType: AutoCompactionCutType;
  now: number;
  archive: AutoCompactionArchivePaths | undefined;
}): Message {
  const lines = [
    "The conversation context before this point has been compacted.",
    "Earlier context is summarized in the compaction message above. Recent messages are retained after that summary, but large textual tool results and tool-recovery payloads may be middle-truncated.",
    "Continue from the summary and retained context without asking the user to repeat information.",
  ];

  if (args.cutType === "split-turn") {
    lines.push(
      "The retained messages begin in the middle of the latest assistant/tool turn. The summary contains the original request and earlier tool work from that turn.",
    );
  }

  if (args.archive) {
    lines.push(
      "The summary and retained context should normally be sufficient. If a specific missing detail is needed, temporary pre-compaction snapshots are available as numbered pairs in one directory:",
      `- this compaction's text transcript: ${args.archive.textPath}`,
      `- this compaction's full JSON: ${args.archive.jsonPath}`,
      "Earlier numbered pairs in the same directory contain older pre-compaction snapshots, so include them in targeted searches when the detail may predate this compaction.",
      "When the compaction summary mentions a history entry id, search the numbered text transcripts for that id first, then inspect the corresponding JSON record if the text transcript is truncated or incomplete.",
      "When retained output is marked as truncated, search the text transcript by tool name and distinctive surrounding text, then inspect the paired JSON record for the complete output.",
      "Prefer narrow searches and bounded reads of the text transcripts; their tool results are middle-truncated. The JSON files retain untruncated archived content and may be very large.",
      "When available, delegating a precise archive lookup to a low-effort subagent can preserve this context more efficiently than reading large sections directly.",
      "These files are temporary and may no longer exist.",
    );
  }

  const hiddenSystemMessages = [lines.join("\n")];

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: formatTauUserText({
          text: "",
          metadata: [{ type: "auto-compaction-continuation", version: 1 }],
          hiddenSystemMessages,
        }),
      },
    ],
    timestamp: args.now,
  };
}

export function selectAutoCompactionCut(
  entries: readonly CompactionHistoryEntry[],
  args: { startIndex: number; keepRecentTokens: number },
): { startIndex: number; cutType: AutoCompactionCutType } | undefined {
  if (entries.length === 0 || args.startIndex >= entries.length) {
    return undefined;
  }

  const turnStarts = collectTurnStarts(entries, args.startIndex);
  const latestTurnStart = turnStarts.at(-1) ?? findOngoingTurnStart(entries, args.startIndex);
  if (latestTurnStart === undefined) {
    return undefined;
  }

  const latestTurnTokens = estimateEntriesTokens(entries.slice(latestTurnStart));
  if (latestTurnTokens <= args.keepRecentTokens) {
    if (turnStarts.length === 0) {
      return undefined;
    }

    let firstKeptTurn = latestTurnStart;
    let totalTokens = latestTurnTokens;

    for (let i = turnStarts.length - 2; i >= 0; i -= 1) {
      const turnStart = turnStarts[i]!;
      const nextTurnStart = turnStarts[i + 1]!;
      const turnTokens = estimateEntriesTokens(entries.slice(turnStart, nextTurnStart));
      if (totalTokens + turnTokens > args.keepRecentTokens) {
        break;
      }
      firstKeptTurn = turnStart;
      totalTokens += turnTokens;
    }

    if (firstKeptTurn <= args.startIndex) {
      return undefined;
    }

    return { startIndex: firstKeptTurn, cutType: "turn-boundary" };
  }

  const splitStart = selectLatestTurnSplitStart(entries, {
    turnStart: latestTurnStart,
    keepRecentTokens: args.keepRecentTokens,
  });
  if (splitStart === undefined) {
    return latestTurnStart > args.startIndex
      ? { startIndex: latestTurnStart, cutType: "turn-boundary" }
      : undefined;
  }
  if (splitStart <= args.startIndex) {
    return undefined;
  }

  return { startIndex: splitStart, cutType: "split-turn" };
}

function findLatestCompactionEntry(entries: readonly CompactionHistoryEntry[]): {
  index: number;
  summary?: string;
  preservedUserMessages: PreservedUserMessage[];
} {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const metadata = getSummaryCompactionMetadataFromMessage(entries[index]!.message);
    if (metadata) {
      const preservedUserMessages = metadata.preservedUserMessages.map((message) => ({
        id: message.id,
        text: message.text,
      }));
      return {
        index,
        summary: metadata.summary,
        preservedUserMessages,
      };
    }
  }

  return { index: -1, preservedUserMessages: [] };
}

function collectTurnStarts(
  entries: readonly CompactionHistoryEntry[],
  startIndex: number,
): number[] {
  const starts: number[] = [];
  for (let index = Math.max(0, startIndex); index < entries.length; index += 1) {
    const message = entries[index]!.message;
    if (message.role !== "user") {
      continue;
    }
    if (
      getSummaryCompactionMetadataFromMessage(message) ||
      hasAutoCompactionContinuationMetadata(message) ||
      hasToolRecoveryMetadata(message)
    ) {
      continue;
    }
    starts.push(index);
  }
  return starts;
}

function findOngoingTurnStart(
  entries: readonly CompactionHistoryEntry[],
  startIndex: number,
): number | undefined {
  for (let index = Math.max(0, startIndex); index < entries.length; index += 1) {
    if (!hasAutoCompactionContinuationMetadata(entries[index]!.message)) {
      return index;
    }
  }
  return undefined;
}

function selectLatestTurnSplitStart(
  entries: readonly CompactionHistoryEntry[],
  args: { turnStart: number; keepRecentTokens: number },
): number | undefined {
  let retainedTokens = 0;
  let latestAssistantBoundary: number | undefined;
  let crossedBudget = false;

  for (let index = entries.length - 1; index >= args.turnStart; index -= 1) {
    const entry = entries[index]!;
    if (hasAutoCompactionContinuationMetadata(entry.message)) {
      continue;
    }

    retainedTokens += estimateMessageTokens(entry.message);

    if (entry.message.role === "assistant") {
      latestAssistantBoundary = index;
    }

    if (retainedTokens > args.keepRecentTokens) {
      crossedBudget = true;
    }
    if (crossedBudget && latestAssistantBoundary !== undefined) {
      return latestAssistantBoundary;
    }
  }

  return latestAssistantBoundary;
}

function estimateEntriesTokens(entries: readonly CompactionHistoryEntry[]): number {
  return entries.reduce(
    (total, entry) =>
      hasAutoCompactionContinuationMetadata(entry.message)
        ? total
        : total + estimateMessageTokens(entry.message),
    0,
  );
}

function estimateMessageTokens(message: Message): number {
  return Math.max(1, bytesToTokens(Buffer.byteLength(JSON.stringify(message), "utf8")));
}

function extractLastAssistantMessage(history: readonly Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role !== "assistant") {
      continue;
    }

    const text = extractAssistantText(history[i]! as AssistantMessage).trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}
