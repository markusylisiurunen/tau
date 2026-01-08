import { homedir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { type RiskLevel, RiskLevelSchema, type Skill } from "./types.js";

const HelpCommandSchema = z.object({ type: z.literal("help") });
const CopyCommandSchema = z.object({ type: z.literal("copy") });
const CopyCodeCommandSchema = z.object({ type: z.literal("copyCode") });
const NewCommandSchema = z.object({ type: z.literal("new") });
const CompactOnlySummaryCommandSchema = z.object({ type: z.literal("compactOnlySummary") });
const CompactSummaryAndLastTurnCommandSchema = z.object({
  type: z.literal("compactSummaryAndLastTurn"),
});
const ReloadCommandSchema = z.object({ type: z.literal("reload") });
const RiskCommandSchema = z.object({
  type: z.literal("risk"),
  level: RiskLevelSchema,
});
const BashCommandSchema = z.object({
  type: z.literal("bash"),
  id: z.string().min(1),
});
const PersonaCommandSchema = z.object({
  type: z.literal("persona"),
  id: z.string().min(1),
});
const PromptCommandSchema = z.object({
  type: z.literal("prompt"),
  id: z.string().min(1),
});
const UnknownCommandSchema = z.object({
  type: z.literal("unknown"),
  raw: z.string(),
});

export const CommandSchema = z.discriminatedUnion("type", [
  HelpCommandSchema,
  CopyCommandSchema,
  CopyCodeCommandSchema,
  NewCommandSchema,
  CompactOnlySummaryCommandSchema,
  CompactSummaryAndLastTurnCommandSchema,
  ReloadCommandSchema,
  RiskCommandSchema,
  BashCommandSchema,
  PersonaCommandSchema,
  PromptCommandSchema,
  UnknownCommandSchema,
]);

export type Command = z.infer<typeof CommandSchema>;

export function parseCommand(raw: string): Command {
  const trimmed = raw.trim();

  if (trimmed === "/help") {
    return CommandSchema.parse({ type: "help" });
  }

  if (trimmed === "/copy") {
    return CommandSchema.parse({ type: "copy" });
  }

  if (trimmed === "/copy:code") {
    return CommandSchema.parse({ type: "copyCode" });
  }

  if (trimmed === "/new") {
    return CommandSchema.parse({ type: "new" });
  }

  if (trimmed === "/compact:only-summary") {
    return CommandSchema.parse({ type: "compactOnlySummary" });
  }

  if (trimmed === "/compact:with-last-turn") {
    return CommandSchema.parse({ type: "compactSummaryAndLastTurn" });
  }

  if (trimmed === "/reload") {
    return CommandSchema.parse({ type: "reload" });
  }

  const riskMatch = trimmed.match(/^\/risk:(restricted|read-only|read-write)$/i);
  if (riskMatch) {
    const level = riskMatch[1]!.toLowerCase() as RiskLevel;
    return CommandSchema.parse({ type: "risk", level });
  }

  const personaMatch = trimmed.match(/^\/persona:(.+)$/i);
  if (personaMatch) {
    const id = personaMatch[1]?.trim() ?? "";
    if (id) {
      return CommandSchema.parse({ type: "persona", id });
    }
  }

  const promptMatch = trimmed.match(/^\/prompt:(.+)$/i);
  if (promptMatch) {
    const id = promptMatch[1]?.trim() ?? "";
    if (id) {
      return CommandSchema.parse({ type: "prompt", id });
    }
  }

  const bashMatch = trimmed.match(/^\/bash:(.+)$/i);
  if (bashMatch) {
    const id = bashMatch[1]?.trim() ?? "";
    if (id) {
      return CommandSchema.parse({ type: "bash", id });
    }
  }

  return CommandSchema.parse({ type: "unknown", raw: trimmed });
}

function formatSkillPath(fullPath: string): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const globalSkillsDir = join(configHome, "tau", "skills");
  const projectSkillsDir = join(process.cwd(), ".tau", "skills");

  // Check if path is in project skills directory
  if (fullPath.startsWith(projectSkillsDir)) {
    const relPath = relative(process.cwd(), fullPath);
    return relPath;
  }

  // Check if path is in global skills directory
  if (fullPath.startsWith(globalSkillsDir)) {
    const relPath = relative(configHome, fullPath);
    if (process.env.XDG_CONFIG_HOME) {
      return `$XDG_CONFIG_HOME/${relPath}`;
    }
    return `~/.config/${relPath}`;
  }

  // Fallback to full path
  return fullPath;
}

export function buildHelpText(agentsFiles?: string[], skills?: Skill[]): string {
  const lines: string[] = [];
  if (agentsFiles && agentsFiles.length > 0) {
    lines.push("context:");
    agentsFiles.forEach((agentsFile) => {
      lines.push(`  ${agentsFile}`);
    });
  }
  if (skills && skills.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("skills:");
    skills.forEach((skill) => {
      lines.push(`  ${skill.name} (${formatSkillPath(skill.path)})`);
    });
  }
  if (lines.length > 0) {
    lines.push("");
  }
  const commandEntries: Array<[string, string]> = [
    ["/help", "show this help"],
    ["/new", "new session"],
    ["/compact:only-summary", "summarize and start new session"],
    ["/compact:with-last-turn", "summarize and include previous last turn"],
    ["/reload", "reload personas, prompts, and skills from disk"],
    ["/copy", "copy last assistant message"],
    ["/copy:code", "copy code blocks from last assistant message"],
    ["/risk:restricted", "restricted tools only (read/grep/list)"],
    ["/risk:read-only", "allow read-only tools"],
    ["/risk:read-write", "allow all tools"],
    ["/bash:<id>", "run saved bash command"],
    ["/persona:<id>", "switch persona"],
    ["/prompt:<id>", "insert prompt template"],
  ];
  const keyEntries: Array<[string, string]> = [
    ["shift+tab", "cycle reasoning effort"],
    ["ctrl+r", "cycle risk level"],
    ["ctrl+p", "cycle personality"],
    ["ctrl+t", "toggle thoughts visibility"],
    ["ctrl+o", "toggle compact tool UI"],
    ["ctrl+f", "expand @file mentions"],
    ["esc", "interrupt assistant"],
  ];

  const commandPad = Math.max(...commandEntries.map(([cmd]) => cmd.length));
  const keyPad = Math.max(...keyEntries.map(([key]) => key.length));

  lines.push("commands:");
  for (const [cmd, desc] of commandEntries) {
    lines.push(`  ${cmd.padEnd(commandPad)}  ${desc}`);
  }
  lines.push("", "keys:");
  for (const [key, desc] of keyEntries) {
    lines.push(`  ${key.padEnd(keyPad)}  ${desc}`);
  }
  return lines.join("\n");
}

export function getRiskLevelDescription(level: RiskLevel): string {
  switch (level) {
    case "restricted":
      return "restricted tools only (read/grep/list)";
    case "read-only":
      return "read-only tools allowed";
    case "read-write":
      return "all tools allowed";
  }
}
