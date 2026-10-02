import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { isSystemCompactionContinuation } from "../../protocol/system_message.js";
import { buildCompactionUserMessage } from "../utils/compact.js";
import { extractAssistantText } from "../utils/messages.js";
import { estimateMessageTokens } from "../utils/token.js";
import {
  formatTauUserText,
  getSummaryCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  hasToolRecoveryMetadata,
} from "../utils/user_metadata.js";
import {
  AUTO_COMPACTION_ARCHIVE_DOCUMENTATION,
  type AutoCompactionArchivePaths,
} from "./auto_compaction_archive.js";

export type CompactionHistoryEntry = {
  id: string;
  message: Message;
};

export type SessionCompactionMode = "only-summary" | "with-last-assistant";

export type SessionCompactionPreparation = {
  messagesToSummarize: Message[];
};

export type SessionCompactionMessageResult = {
  compactionMessage: string;
  includedLastAssistant: boolean;
};

export type AutoCompactionCutType = "turn-boundary" | "split-turn";

export type AutoCompactionPreparation = SessionCompactionPreparation & {
  retainedEntries: CompactionHistoryEntry[];
  cutType: AutoCompactionCutType;
};

const COMPACTION_SUMMARIZATION_PROMPT = `You are pausing your current work to compact your own conversation and free space in your context window. The conversation you can see now will be replaced with the compaction summary you write. After that, you will continue as the same agent in the same session, working on the same task, but without the full earlier conversation available.

Write a compaction summary of the conversation: what the user asked for, what has been done and learned, and what remains to be done. It should also give you the handoff you will need to resume that work as smoothly as possible. Your next continuation should be able to understand what the user wants, where the work stands, and what to do next from the compaction summary alone. Think through what you would otherwise forget: important constraints, evidence, decisions and their rationale, unresolved questions, and unfinished work. Preserve what will let you continue without reconstructing the conversation, repeating completed work, or asking the user to explain it again. Recent messages may also remain, but treat them as additional detail rather than something your compaction summary depends on. Some overlap is expected.

Preserve continuity-critical information in compact form:
- The current objective, still-relevant original requests, and user constraints, preferences, and corrections.
- Confirmed progress, current work, blockers, and the next concrete actions.
- Decisions and their useful rationale, including rejected approaches when they matter for continuation.
- Evidence needed to resume: exact paths, identifiers, commands, important errors, and verification status.
- Uncertainties, unverified assumptions, pending validation, and the difference between attempted work and confirmed outcomes.
- For unfinished tool work, the request being pursued, results already received, and what remains to interpret or do. Do not repeat completed tool calls just because the earlier exchange is no longer visible.

Incorporate still-relevant information from any previous compaction summary. Remove information that is clearly obsolete or superseded. Collapse tangents and repetition unless they affect the work. When a detail may matter later, preserve it concisely rather than omitting it solely for brevity.

Choose the structure that best supports your continuation. Goal, Constraints, Progress, Decisions, Next actions, and Critical context can be useful headings, but are not a required form. Record actionable conclusions and rationale, not a transcript of internal thinking. The base system instructions remain available separately; do not spend the compaction summary reproducing them.

Do not include large verbatim chunks from user messages, pasted documents, or tool output. Summarize the relevant requirements and findings.

Output only the compaction summary.

Do not answer the latest request, perform more work, or call tools.`;

export function prepareSessionCompaction(
  entries: readonly CompactionHistoryEntry[],
): SessionCompactionPreparation | undefined {
  const latestCompactionIndex = findLatestCompactionIndex(entries);
  const activeEntries = entries.filter((entry) => !isCompactionContinuation(entry.message));
  if (
    !entries
      .slice(latestCompactionIndex + 1)
      .some((entry) => !isCompactionContinuation(entry.message))
  ) {
    return undefined;
  }
  return {
    messagesToSummarize: activeEntries.map((entry) => entry.message),
  };
}

export function buildSessionCompactionPrompt(args: { guidance?: string } = {}): string {
  const guidance = args.guidance?.trim();
  return guidance
    ? `${COMPACTION_SUMMARIZATION_PROMPT}\n\nAdditional compaction summary focus: ${guidance}`
    : COMPACTION_SUMMARIZATION_PROMPT;
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
  const preparation = prepareSessionCompaction(entries);
  if (!preparation) {
    return undefined;
  }
  const latestCompactionIndex = findLatestCompactionIndex(entries);
  const cut = selectAutoCompactionCut(entries, {
    startIndex: latestCompactionIndex + 1,
    keepRecentTokens: settings.keepRecentTokens,
  });
  if (!cut) {
    return undefined;
  }
  return {
    ...preparation,
    retainedEntries: entries
      .slice(cut.startIndex)
      .filter((entry) => !isCompactionContinuation(entry.message))
      .map((entry) => structuredClone(entry)),
    cutType: cut.cutType,
  };
}

export function buildAutoCompactionPrompt(): string {
  return buildSessionCompactionPrompt({
    guidance:
      "After this compaction summary, some recent complete messages may remain, or there may be no retained messages. Do not rely on a particular retention boundary. After compaction, you will have access to a transcript archive of the conversation before this compaction: a readable .txt transcript, a structured .json snapshot, and an archive guide. The text transcript may truncate large tool results; the JSON snapshot retains full archived results but excludes assistant thinking. You can refer to this transcript archive for exact wording or bulky evidence instead of copying it into the summary. Include targeted instructions to revisit a relevant user message or other evidence when useful, explaining what to look for and why it matters. Use distinctive details such as the topic of a user request, a file path, a tool name, or an error. The continuation supplies the actual paths, so do not invent paths or entry IDs. Keep the essential context in the summary; the transcript archive is an additional way to recover details, not a substitute for a useful summary. This transcript archive is separate from the history tool's collection.",
  });
}

export const COMPACTION_CONTINUATION_GUIDANCE = `Your earlier conversation was compacted to keep this same session within the context limit, not to start a new task.
The compaction summary supplies continuity. Any retained recent messages supply additional detail and may overlap with it. Compaction does not mean that work completed or that the user request changed.
Resume from the compaction summary and any retained messages without repeating completed work. Recover missing evidence when it matters rather than guessing or asking the user to repeat information.`;

export function buildAutoCompactionContinuationMessage(args: {
  cutType: AutoCompactionCutType;
  now: number;
  archive: AutoCompactionArchivePaths | undefined;
  systemMessages?: readonly string[];
}): Message {
  const lines = [COMPACTION_CONTINUATION_GUIDANCE];

  if (args.cutType === "split-turn") {
    lines.push(
      "The retained suffix may begin partway through a user turn, or be empty. Use the compaction summary to understand earlier requests, prior tool work, and unfinished actions that are no longer visible.",
    );
  }

  if (args.archive) {
    lines.push(
      "The summary and retained context should normally be sufficient. The transcript archive from before this compaction is also available:",
      `- archive guide: ${args.archive.documentationPath}`,
      `- transcript archive (.txt): ${args.archive.textPath}`,
      `- transcript archive (.json): ${args.archive.jsonPath}`,
      "The archive guide is included below and remains available at the path above.",
      "For details removed from this session by automatic compaction, use this transcript archive rather than the separate history tool, whose collection may be stale, remotely replicated, truncated, or unavailable.",
      "The guide describes the archive format and adaptable, bounded lookup examples, including how to inspect earlier numbered pairs when needed.",
      "<transcript-archive-guide>",
      AUTO_COMPACTION_ARCHIVE_DOCUMENTATION,
      "</transcript-archive-guide>",
    );
  }

  const hiddenSystemMessages = [...(args.systemMessages ?? []), lines.join("\n")];

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

  let retainedTokens = 0;
  let startIndex = entries.length;
  for (let index = entries.length - 1; index >= args.startIndex; index -= 1) {
    if (isCompactionContinuation(entries[index]!.message)) {
      continue;
    }
    let groupStart = index;
    if (entries[index]!.message.role === "toolResult") {
      while (groupStart > args.startIndex) {
        groupStart -= 1;
        const message = entries[groupStart]!.message;
        if (message.role === "assistant") {
          break;
        }
        if (message.role !== "toolResult" && !isCompactionContinuation(message)) {
          break;
        }
      }
      if (entries[groupStart]!.message.role !== "assistant") {
        break;
      }
    }
    const groupTokens = estimateEntriesTokens(entries.slice(groupStart, index + 1));
    if (retainedTokens + groupTokens > args.keepRecentTokens) {
      break;
    }
    retainedTokens += groupTokens;
    startIndex = groupStart;
    index = groupStart;
  }
  if (startIndex <= args.startIndex) {
    return undefined;
  }
  const message = entries[startIndex]?.message;
  const cutType =
    message?.role === "user" && !hasToolRecoveryMetadata(message) ? "turn-boundary" : "split-turn";
  return { startIndex, cutType };
}

function findLatestCompactionIndex(entries: readonly CompactionHistoryEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (getSummaryCompactionMetadataFromMessage(entries[index]!.message)) {
      return index;
    }
  }
  return -1;
}

function estimateEntriesTokens(entries: readonly CompactionHistoryEntry[]): number {
  return entries.reduce(
    (total, entry) =>
      isCompactionContinuation(entry.message)
        ? total
        : total + estimateMessageTokens(entry.message),
    0,
  );
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

function isCompactionContinuation(message: Message): boolean {
  return hasAutoCompactionContinuationMetadata(message) || isSystemCompactionContinuation(message);
}
