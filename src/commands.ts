import type { ToolAccessLevel } from "./types.js";

export type Command =
  | { type: "help" }
  | { type: "copy" }
  | { type: "new" }
  | { type: "tool"; level: ToolAccessLevel }
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

  if (trimmed === "/new") {
    return { type: "new" };
  }

  const toolMatch = trimmed.match(/^\/tool:(none|read|all)$/i);
  if (toolMatch) {
    const level = toolMatch[1]!.toLowerCase() as ToolAccessLevel;
    return { type: "tool", level };
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
    lines.push("agents files:");
    agentsFiles.forEach((agentsFile) => {
      lines.push(`  ${agentsFile}`);
    });
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(
    "commands:",
    "  /help           show this help",
    "  /new            new session",
    "  /copy           copy last assistant message",
    "  /tool:none      disable all tools",
    "  /tool:read      allow read-only tools",
    "  /tool:all       allow all tools",
    "  /persona:<id>   switch persona",
    "  /prompt:<id>    insert prompt template",
    "",
    "keys:",
    "  shift+tab       cycle reasoning effort",
    "  ctrl+t          toggle thoughts visibility",
    "  esc             interrupt assistant",
  );
  return lines.join("\n");
}

export function getToolLevelDescription(level: ToolAccessLevel): string {
  switch (level) {
    case "none":
      return "all tools disabled";
    case "read":
      return "read-only tools allowed";
    case "all":
      return "all tools allowed";
  }
}
