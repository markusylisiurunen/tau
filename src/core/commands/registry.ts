import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { type RiskLevel, RiskLevelSchema, type Skill } from "../types.js";

export type Command =
  | { type: "help" }
  | { type: "copy" }
  | { type: "copyCode" }
  | { type: "export" }
  | { type: "new" }
  | { type: "compactOnlySummary" }
  | { type: "compactSummaryAndLastTurn" }
  | { type: "reload" }
  | { type: "risk"; level: RiskLevel }
  | { type: "bash"; id: string }
  | { type: "persona"; id: string }
  | { type: "prompt"; id: string }
  | { type: "unknown"; raw: string };

export type CommandId = Command["type"];
export type CommandArgument = "none" | "risk" | "bash" | "persona" | "prompt";
export type CommandSection = "base" | "risk" | "trailing";

export interface CommandInfo {
  id: CommandId;
  usage: string;
  description: string;
  autocompleteDescription?: string;
  argument: CommandArgument;
  section: CommandSection;
}

interface CommandDefinition<Ctx, T extends Command = Command> extends CommandInfo {
  parse: (raw: string) => T | null;
  run: (ctx: Ctx, command: T) => Promise<void> | void;
  hidden?: boolean;
  allowDuringStreaming?: boolean;
}

export interface CommandDispatchContext {
  help: () => void;
  copy: () => Promise<void>;
  copyCode: () => Promise<void>;
  export: () => Promise<void>;
  newSession: () => void;
  compactOnlySummary: () => Promise<void>;
  compactSummaryAndLastTurn: () => Promise<void>;
  reload: () => Promise<void>;
  risk: (level: RiskLevel) => void;
  persona: (id: string) => void;
  prompt: (id: string) => void;
  bash: (id: string) => Promise<void>;
  unknown: (raw: string) => void;
}

export interface HelpTextOptions {
  agentsFiles?: string[];
  skills?: Skill[];
  riskLevels?: RiskLevel[];
}

const DEFAULT_RISK_LEVELS: RiskLevel[] = ["restricted", "read-only", "read-write"];
const RISK_LEVEL_HELP_DESCRIPTIONS: Record<RiskLevel, string> = {
  restricted: "restricted tools only (read/grep/list)",
  "read-only": "allow read-only tools",
  "read-write": "allow all tools",
};

export function getRiskLevelDescription(level: RiskLevel): string {
  switch (level) {
    case "restricted":
      return "read/grep/list tools only";
    case "read-only":
      return "read-only tools";
    case "read-write":
      return "all tools";
  }
}

export function getRiskLevelAutocompleteOptions(
  allowed: RiskLevel[],
): Array<{ id: RiskLevel; description: string }> {
  return allowed.map((level) => ({
    id: level,
    description: RISK_LEVEL_HELP_DESCRIPTIONS[level],
  }));
}

function formatSkillPath(fullPath: string): string {
  const cwd = process.cwd();
  const home = homedir();

  if (fullPath === cwd || fullPath.startsWith(cwd + sep)) {
    return relative(cwd, fullPath);
  }

  if (fullPath === home || fullPath.startsWith(home + sep)) {
    const relPath = relative(home, fullPath);
    return relPath ? `~/${relPath}` : "~";
  }

  return fullPath;
}

export class CommandRegistry<Ctx = unknown> {
  private readonly commands: Array<CommandDefinition<Ctx, Command>> = [];
  private readonly byId = new Map<CommandId, CommandDefinition<Ctx, Command>>();

  register<T extends Command>(definition: CommandDefinition<Ctx, T>): void {
    const def = definition as unknown as CommandDefinition<Ctx, Command>;
    this.commands.push(def);
    this.byId.set(definition.id, def);
  }

  parse(raw: string): Command {
    const trimmed = raw.trim();
    for (const command of this.commands) {
      if (command.hidden) continue;
      const match = command.parse(trimmed);
      if (match) return match;
    }
    return { type: "unknown", raw: trimmed };
  }

  async dispatch(command: Command, ctx: Ctx): Promise<void> {
    const handler = this.byId.get(command.type);
    if (!handler) return;
    await handler.run(ctx, command as Command);
  }

  list(): CommandInfo[] {
    return this.commands
      .filter((command) => !command.hidden)
      .map(({ parse, run, hidden, ...info }) => info);
  }

  allowsDuringStreaming(command: Command): boolean {
    const handler = this.byId.get(command.type);
    return Boolean(handler?.allowDuringStreaming);
  }

  buildHelpText(options: HelpTextOptions = {}): string {
    const lines: string[] = [];
    const { agentsFiles, skills, riskLevels } = options;

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

    const commands = this.list();
    const baseCommands = commands.filter((command) => command.section === "base");
    const trailingCommands = commands.filter((command) => command.section === "trailing");
    const riskCommand = commands.find((command) => command.section === "risk");

    const commandEntries: Array<[string, string]> = [];
    baseCommands.forEach((command) => {
      commandEntries.push([command.usage, command.description]);
    });

    if (riskCommand) {
      const allowed = riskLevels ?? DEFAULT_RISK_LEVELS;
      allowed.forEach((level) => {
        const description = RISK_LEVEL_HELP_DESCRIPTIONS[level];
        commandEntries.push([`/risk:${level}`, description]);
      });
    }

    trailingCommands.forEach((command) => {
      commandEntries.push([command.usage, command.description]);
    });

    const keyEntries: Array<[string, string]> = [
      ["shift+tab", "cycle reasoning effort"],
      ["ctrl+r", "cycle risk level"],
      ["ctrl+p", "cycle personality"],
      ["ctrl+t", "toggle thoughts visibility"],
      ["ctrl+o", "toggle compact tool UI"],
      ["ctrl+f", "expand @file and $skill mentions"],
      ["ctrl+s", "stash input to clipboard"],
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
}

export function createCommandRegistry(): CommandRegistry<CommandDispatchContext> {
  const registry = new CommandRegistry<CommandDispatchContext>();

  registry.register({
    id: "help",
    usage: "/help",
    description: "show this help",
    autocompleteDescription: "show help",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/help" ? { type: "help" } : null),
    run: (ctx) => ctx.help(),
  });

  registry.register({
    id: "new",
    usage: "/new",
    description: "new session",
    autocompleteDescription: "new session",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/new" ? { type: "new" } : null),
    run: (ctx) => ctx.newSession(),
  });

  registry.register({
    id: "compactOnlySummary",
    usage: "/compact:only-summary",
    description: "summarize and start new session",
    autocompleteDescription: "compact history to a summary",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/compact:only-summary" ? { type: "compactOnlySummary" } : null),
    run: (ctx) => ctx.compactOnlySummary(),
  });

  registry.register({
    id: "compactSummaryAndLastTurn",
    usage: "/compact:with-last-turn",
    description: "summarize and include previous last turn",
    autocompleteDescription: "compact history, keep last turn",
    argument: "none",
    section: "base",
    parse: (raw) =>
      raw === "/compact:with-last-turn" ? { type: "compactSummaryAndLastTurn" } : null,
    run: (ctx) => ctx.compactSummaryAndLastTurn(),
  });

  registry.register({
    id: "reload",
    usage: "/reload",
    description: "reload personas, prompts, skills, and themes from disk",
    autocompleteDescription: "reload personas, prompts, skills, and themes from disk",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/reload" ? { type: "reload" } : null),
    run: (ctx) => ctx.reload(),
  });

  registry.register({
    id: "copy",
    usage: "/copy",
    description: "copy last assistant message",
    autocompleteDescription: "copy last assistant message",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/copy" ? { type: "copy" } : null),
    run: (ctx) => ctx.copy(),
  });

  registry.register({
    id: "copyCode",
    usage: "/copy:code",
    description: "copy code blocks from last assistant message",
    autocompleteDescription: "copy code blocks from last assistant message",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/copy:code" ? { type: "copyCode" } : null),
    run: (ctx) => ctx.copyCode(),
  });

  registry.register({
    id: "export",
    usage: "/export:html",
    description: "export chat history to HTML",
    autocompleteDescription: "export chat history to HTML",
    argument: "none",
    section: "base",
    parse: (raw) => (raw === "/export:html" ? { type: "export" } : null),
    run: (ctx) => ctx.export(),
  });

  registry.register({
    id: "risk",
    usage: "/risk:<level>",
    description: "set risk level",
    argument: "risk",
    section: "risk",
    parse: (raw) => {
      const match = raw.match(/^\/risk:(restricted|read-only|read-write)$/i);
      if (!match) return null;
      const parsed = RiskLevelSchema.safeParse(match[1]?.toLowerCase());
      if (!parsed.success) return null;
      return { type: "risk", level: parsed.data };
    },
    run: (ctx, command) => ctx.risk(command.level),
  });

  registry.register({
    id: "bash",
    usage: "/bash:<id>",
    description: "run saved bash command",
    argument: "bash",
    section: "trailing",
    parse: (raw) => {
      const match = raw.match(/^\/bash:(.+)$/i);
      const id = match?.[1]?.trim() ?? "";
      if (!id) return null;
      return { type: "bash", id };
    },
    run: (ctx, command) => ctx.bash(command.id),
  });

  registry.register({
    id: "persona",
    usage: "/persona:<id>",
    description: "switch persona",
    argument: "persona",
    section: "trailing",
    parse: (raw) => {
      const match = raw.match(/^\/persona:(.+)$/i);
      const id = match?.[1]?.trim() ?? "";
      if (!id) return null;
      return { type: "persona", id };
    },
    run: (ctx, command) => ctx.persona(command.id),
  });

  registry.register({
    id: "prompt",
    usage: "/prompt:<id>",
    description: "insert prompt template",
    argument: "prompt",
    section: "trailing",
    allowDuringStreaming: true,
    parse: (raw) => {
      const match = raw.match(/^\/prompt:(.+)$/i);
      const id = match?.[1]?.trim() ?? "";
      if (!id) return null;
      return { type: "prompt", id };
    },
    run: (ctx, command) => ctx.prompt(command.id),
  });

  registry.register<{ type: "unknown"; raw: string }>({
    id: "unknown",
    usage: "",
    description: "",
    argument: "none",
    section: "base",
    hidden: true,
    parse: () => null,
    run: (ctx, command) => ctx.unknown(command.raw),
  });

  return registry;
}
