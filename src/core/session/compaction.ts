import { Buffer } from "node:buffer";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { buildCompactionUserMessage, formatHistoryForCompaction } from "../utils/compact.js";
import { extractAssistantText } from "../utils/messages.js";
import { prependModelNotice } from "../utils/model_notices.js";
import { bytesToTokens } from "../utils/token.js";
import {
  getSummaryCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  prependTauUserMetadata,
} from "../utils/user_metadata.js";

export type CompactionHistoryEntry = {
  id: string;
  message: Message;
};

export type SessionCompactionMode = "only-summary" | "with-last-assistant";

type CompactionPromptPreparation = {
  previousSummary?: string;
  formattedHistory: string;
};

export type SessionCompactionPreparation = CompactionPromptPreparation & {
  messagesToSummarize: Message[];
};

export type SessionCompactionMessageResult = {
  compactionMessage: string;
  includedLastAssistant: boolean;
};

export type AutoCompactionCutType = "turn-boundary" | "split-turn";

export type AutoCompactionPreparation = CompactionPromptPreparation & {
  retainedEntries: CompactionHistoryEntry[];
  cutType: AutoCompactionCutType;
};

export const COMPACTION_SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context compaction assistant. Your output will replace the conversation history for another assistant. Do not continue the conversation. Do not answer any conversation questions. Only output the structured summary in the exact format requested.";

const COMPACTION_SUMMARIZATION_PROMPT = `The messages above are a conversation to compact. Create an information-dense context checkpoint summary that will replace the full conversation history. Another assistant should be able to continue the session from this summary as if the original conversation were still available.

Use this exact format:

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

Rules:
- Preserve as much continuity-critical context as possible while removing tokens.
- Keep each section information-dense and focused; do not omit useful details solely for brevity.
- When unsure whether a detail may matter later, preserve it in compact form.
- Preserve the current state of the work: files touched, commands run, test/build status, known failures, unverified assumptions, and pending validation.
- Distinguish attempted work from confirmed outcomes.
- If goals evolved over time, capture the current goal and briefly note the change.
- Collapse tangents, retries, and pleasantries unless they materially affect decisions, blockers, or next steps.
- Preserve exact file paths, function names, commands, and error messages.`;

const COMPACTION_UPDATE_SUMMARIZATION_PROMPT = `The messages above are new conversation messages to incorporate into the existing summary in <previous-summary> tags. The updated summary will replace the prior summary plus these new messages as the session's continuity context.

Update the existing structured summary with these rules:
- Preserve all still-relevant information from the previous summary.
- Add new progress, decisions, and context from the new messages.
- Move items from In Progress to Done when completed.
- Update Next Steps based on the current state.
- Remove only information that is clearly obsolete, superseded, or irrelevant to continuing the session.

Use the exact same format as before:

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

Rules:
- Preserve as much continuity-critical context as possible while removing tokens.
- Keep each section information-dense and focused; do not omit useful details solely for brevity.
- When unsure whether a detail may matter later, preserve it in compact form.
- Preserve the current state of the work: files touched, commands run, test/build status, known failures, unverified assumptions, and pending validation.
- Distinguish attempted work from confirmed outcomes.
- If goals evolved over time, capture the current goal and briefly note the change.
- Collapse tangents, retries, and pleasantries unless they materially affect decisions, blockers, or next steps.
- Preserve exact file paths, function names, commands, and error messages.`;

export function prepareSessionCompaction(
  history: readonly Message[],
): SessionCompactionPreparation | undefined {
  const latestCompaction = findLatestCompaction(history);
  const messagesToSummarize = history
    .slice(latestCompaction.index + 1)
    .filter((message) => !hasAutoCompactionContinuationMetadata(message));
  const formattedHistory = formatHistoryForCompaction(messagesToSummarize);
  if (!formattedHistory) {
    return undefined;
  }

  return {
    previousSummary: latestCompaction.summary,
    messagesToSummarize,
    formattedHistory,
  };
}

function findLatestCompaction(history: readonly Message[]): { index: number; summary?: string } {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const metadata = getSummaryCompactionMetadataFromMessage(history[index]!);
    if (metadata) {
      return { index, summary: metadata.summary };
    }
  }

  return { index: -1 };
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
}): SessionCompactionMessageResult {
  const lastAssistantMessage =
    args.mode === "with-last-assistant"
      ? extractLastAssistantMessage(args.messagesToSummarize)
      : undefined;

  return {
    compactionMessage: buildCompactionUserMessage({
      summary: args.summary,
      lastAssistantMessage,
    }),
    includedLastAssistant: Boolean(lastAssistantMessage),
  };
}

export function prepareAutoCompaction(
  entries: readonly CompactionHistoryEntry[],
  settings: { keepRecentTokens: number },
): AutoCompactionPreparation | undefined {
  const latestCompaction = findLatestCompactionEntry(entries);
  const cut = selectAutoCompactionCut(entries, {
    startIndex: latestCompaction.index + 1,
    keepRecentTokens: settings.keepRecentTokens,
  });
  if (!cut) {
    return undefined;
  }

  const messagesToSummarize = entries
    .slice(latestCompaction.index + 1, cut.startIndex)
    .map((entry) => entry.message)
    .filter((message) => !hasAutoCompactionContinuationMetadata(message));
  const formattedHistory = formatHistoryForCompaction(messagesToSummarize);
  if (!formattedHistory) {
    return undefined;
  }

  const retainedEntries = entries
    .slice(cut.startIndex)
    .filter((entry) => !hasAutoCompactionContinuationMetadata(entry.message))
    .map((entry) => ({ ...entry }));
  if (retainedEntries.length === 0) {
    return undefined;
  }

  return {
    previousSummary: latestCompaction.summary,
    retainedEntries,
    cutType: cut.cutType,
    formattedHistory,
  };
}

export function buildAutoCompactionPrompt(preparation: AutoCompactionPreparation): string {
  return buildSessionCompactionPrompt({
    preparation,
    guidance:
      preparation.cutType === "split-turn"
        ? "The retained context will begin in the middle of the latest assistant/tool turn. Ensure the summary preserves the original user request, earlier tool work, and the state immediately before the retained suffix."
        : "The retained context will include recent messages verbatim. Ensure the summary complements that retained context without duplicating unnecessary detail.",
  });
}

export function buildAutoCompactionContinuationMessage(args: {
  cutType: AutoCompactionCutType;
  now: number;
  modelNotice?: string;
  subagentStatus?: string;
}): Message {
  const lines = [
    "<system>",
    "The conversation context before this point has been compacted.",
    "Earlier context is summarized in the compaction message above. Recent messages are retained verbatim after that summary.",
    "Continue from the summary and retained context without asking the user to repeat information.",
  ];

  if (args.cutType === "split-turn") {
    lines.push(
      "The retained messages begin in the middle of the latest assistant/tool turn. The summary contains the original request and earlier tool work from that turn.",
    );
  }

  const subagentStatus = args.subagentStatus?.trim();
  if (subagentStatus) {
    lines.push("", "<active-subagents>", subagentStatus, "</active-subagents>");
  }

  lines.push("</system>");

  const text = prependModelNotice(lines.join("\n"), args.modelNotice);

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: prependTauUserMetadata(text, [{ type: "auto-compaction-continuation", version: 1 }]),
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
} {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const metadata = getSummaryCompactionMetadataFromMessage(entries[index]!.message);
    if (metadata) {
      return { index, summary: metadata.summary };
    }
  }

  return { index: -1 };
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
      hasAutoCompactionContinuationMetadata(message)
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
