import type { Command } from "../../core/commands/registry.js";

export function getCommandHint(command: Command): string | undefined {
  switch (command.type) {
    case "help":
      return "show available commands";
    case "copyText":
      return "copy last assistant message";
    case "copyCode":
      return "copy last assistant code blocks";
    case "new":
      return "clear the session and start fresh";
    case "rewind":
      return "rewind context to a selected prior user message";
    case "diff":
      return "open the local diff review tool: /diff [git diff args...]";
    case "compactSummaryOnly":
      return "summarize session and start new, optional prompt";
    case "compactSummaryAndLast":
      return "summarize session and keep last turn, optional prompt";
    case "pruneEarliest":
      return "prune earliest tool results and compact edit calls, optional fraction 0-1";
    case "pruneLargest":
      return "prune largest tool results and compact edit calls, optional fraction 0-1";
    case "pruneSmart":
      return "prune smart-selected tool results and compact edit calls, optional fraction and guidance";
    case "reload":
      return "reload prompts, skills, personas, and AGENTS.md";
    case "listen":
      return "start microphone recording and transcribe to editor (macOS only)";
    case "speak":
      return "speak the last assistant message aloud (macOS only)";
    case "risk":
      return "set risk level: /risk:read-only or /risk:read-write";
    case "persona":
      return "switch persona: /persona:<id>";
    case "prompt":
      return "insert prompt template: /prompt:<id>";
    case "theme":
      return "switch theme: /theme:<id>";
    case "unknown":
      return undefined;
  }
}
