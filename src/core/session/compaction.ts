import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
  buildCompactionUserMessage,
  formatHistoryForCompaction,
  partitionHistoryForCompaction,
} from "../utils/compact.js";
import { extractAssistantText } from "../utils/messages.js";
import type { TokenCounter } from "../utils/token_counting.js";

export type SessionCompactionMode = "only-summary" | "with-last-assistant";

export type SessionCompactionPreparation = {
  previousSummary?: string;
  messagesToSummarize: Message[];
  formattedHistory: string;
};

export type SessionCompactionMessageResult = {
  compactionMessage: string;
  includedLastAssistant: boolean;
};

export const COMPACTION_SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Do not continue the conversation. Do not answer any conversation questions. Only output the structured summary in the exact format requested.";

const COMPACTION_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another assistant will use to continue the work.

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
- [Concrete details needed to resume: file paths, function names, commands, errors]

Rules:
- Preserve enough detail for seamless continuation from this summary alone.
- Keep each section concise and focused on continuity-critical information.
- Distinguish attempted work from confirmed outcomes.
- If goals evolved over time, capture the current goal and briefly note the change.
- Collapse tangents, retries, and pleasantries unless they materially affect decisions, blockers, or next steps.
- Preserve exact file paths, function names, commands, and error messages.`;

const COMPACTION_UPDATE_SUMMARIZATION_PROMPT = `The messages above are new conversation messages to incorporate into the existing summary in <previous-summary> tags.

Update the existing structured summary with these rules:
- Preserve all still-relevant information from the previous summary.
- Add new progress, decisions, and context from the new messages.
- Move items from In Progress to Done when completed.
- Update Next Steps based on the current state.
- Remove information that is no longer relevant.

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
- [Concrete details needed to resume: file paths, function names, commands, errors]

Rules:
- Preserve enough detail for seamless continuation from this summary alone.
- Keep each section concise and focused on continuity-critical information.
- Distinguish attempted work from confirmed outcomes.
- If goals evolved over time, capture the current goal and briefly note the change.
- Collapse tangents, retries, and pleasantries unless they materially affect decisions, blockers, or next steps.
- Preserve exact file paths, function names, commands, and error messages.`;

export async function prepareSessionCompaction(
  history: readonly Message[],
  tokenCounter: TokenCounter,
): Promise<SessionCompactionPreparation | undefined> {
  const { previousSummary, messagesToSummarize } = partitionHistoryForCompaction(history);
  const formattedHistory = await formatHistoryForCompaction(messagesToSummarize, tokenCounter);
  if (!formattedHistory) {
    return undefined;
  }

  return {
    previousSummary,
    messagesToSummarize,
    formattedHistory,
  };
}

export function buildSessionCompactionPrompt(args: {
  preparation: SessionCompactionPreparation;
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
