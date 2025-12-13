import type { RiskLevel } from "./types.js";

export type Command =
  | { type: "help" }
  | { type: "copy" }
  | { type: "copyCode" }
  | { type: "new" }
  | { type: "fork" }
  | { type: "reload" }
  | { type: "risk"; level: RiskLevel }
  | { type: "persona"; id: string }
  | { type: "prompt"; id: string }
  | { type: "unknown"; raw: string };

export function parseCommand(raw: string): Command {
  const trimmed = raw.trim();

  if (trimmed === "/help") {
    return { type: "help" };
  }

  if (trimmed === "/copy") {
    return { type: "copy" };
  }

  if (trimmed === "/copy:code") {
    return { type: "copyCode" };
  }

  if (trimmed === "/new") {
    return { type: "new" };
  }

  if (trimmed === "/fork") {
    return { type: "fork" };
  }

  if (trimmed === "/reload") {
    return { type: "reload" };
  }

  const riskMatch = trimmed.match(/^\/risk:(none|read-only|read-write)$/i);
  if (riskMatch) {
    const level = riskMatch[1]!.toLowerCase() as RiskLevel;
    return { type: "risk", level };
  }

  const personaMatch = trimmed.match(/^\/persona:(.+)$/i);
  if (personaMatch) {
    const id = personaMatch[1]?.trim() ?? "";
    if (id) {
      return { type: "persona", id };
    }
  }

  const promptMatch = trimmed.match(/^\/prompt:(.+)$/i);
  if (promptMatch) {
    const id = promptMatch[1]?.trim() ?? "";
    if (id) {
      return { type: "prompt", id };
    }
  }

  return { type: "unknown", raw: trimmed };
}

export function buildHelpText(agentsFiles?: string[]): string {
  const lines: string[] = [];
  if (agentsFiles && agentsFiles.length > 0) {
    lines.push("context:");
    agentsFiles.forEach((agentsFile) => {
      lines.push(`  ${agentsFile}`);
    });
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(
    "commands:",
    "  /help             show this help",
    "  /new              new session",
    "  /fork             summarize and start new session",
    "  /reload           reload personas and prompts from disk",
    "  /copy             copy last assistant message",
    "  /copy:code        copy code blocks from last assistant message",
    "  /risk:none        disable all tools",
    "  /risk:read-only   allow read-only tools",
    "  /risk:read-write  allow all tools",
    "  /persona:<id>     switch persona",
    "  /prompt:<id>      insert prompt template",
    "",
    "keys:",
    "  shift+tab         cycle reasoning effort",
    "  ctrl+t            toggle thoughts visibility",
    "  ctrl+e            expand @file mentions",
    "  esc               interrupt assistant",
  );
  return lines.join("\n");
}

export function getRiskLevelDescription(level: RiskLevel): string {
  switch (level) {
    case "none":
      return "all tools disabled";
    case "read-only":
      return "read-only tools allowed";
    case "read-write":
      return "all tools allowed";
  }
}
