import { dirname } from "node:path";
import type { Skill } from "../types.js";
import { formatPathForDisplay } from "../utils/format.js";

export type Command = (
  | { type: "help" }
  | { type: "copyText" }
  | { type: "copyCode" }
  | { type: "exit" }
  | { type: "new" }
  | { type: "rewind" }
  | { type: "diff"; argsText: string }
  | { type: "compactSummaryOnly" }
  | { type: "compactSummaryAndLast" }
  | { type: "pruneEarliest" }
  | { type: "pruneLargest" }
  | { type: "pruneSmart" }
  | { type: "reload" }
  | { type: "listen" }
  | { type: "speak" }
  | { type: "persona"; id: string }
  | { type: "prompt"; id: string }
  | { type: "theme"; id: string }
  | { type: "unknown"; raw: string }
) & { extra?: string };

export type CommandId = Command["type"];
export type CommandArgument = "none" | "persona" | "prompt" | "theme";
export type CommandSection = "base" | "trailing";

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
  copyText: () => Promise<void>;
  copyCode: () => Promise<void>;
  exit: () => void;
  newSession: () => Promise<void>;
  rewind: () => void;
  diff: (argsText: string) => Promise<void> | void;
  compactSummaryOnly: (extra?: string) => Promise<void>;
  compactSummaryAndLast: (extra?: string) => Promise<void>;
  pruneEarliest: (extra?: string) => void;
  pruneLargest: (extra?: string) => void;
  pruneSmart: (extra?: string) => Promise<void> | void;
  reload: () => Promise<void>;
  listen: () => Promise<void> | void;
  speak: () => Promise<void> | void;
  persona: (id: string) => void;
  prompt: (id: string) => void;
  theme: (id: string) => void;
  unknown: (raw: string) => void;
}

export interface HelpTextOptions {
  agentsFiles?: string[];
  skills?: Skill[];
  themes?: string[];
  formatPath?: (path: string) => string;
}

function formatSkillPath(fullPath: string, formatPath: (path: string) => string): string {
  return formatPath(dirname(dirname(fullPath)));
}

function splitCommandInput(raw: string): { command: string; extra?: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/s);
  const command = match?.[1] ?? trimmed;
  const extra = match?.[2]?.trim();
  return extra ? { command, extra } : { command };
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
    const { agentsFiles, skills, themes } = options;
    const formatPath = options.formatPath ?? formatPathForDisplay;

    if (agentsFiles && agentsFiles.length > 0) {
      lines.push("context:");
      agentsFiles.forEach((agentsFile) => {
        lines.push(`  ${formatPath(agentsFile)}`);
      });
    }
    if (skills && skills.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("skills:");
      skills.forEach((skill) => {
        lines.push(`  ${skill.name} (${formatSkillPath(skill.path, formatPath)})`);
      });
    }
    if (lines.length > 0) {
      lines.push("");
    }

    const hasThemes = (themes?.length ?? 0) > 0;
    const commands = this.list().filter((command) => command.argument !== "theme" || hasThemes);
    const baseCommands = commands.filter((command) => command.section === "base");
    const trailingCommands = commands.filter((command) => command.section === "trailing");

    const commandEntries: Array<[string, string]> = [];
    baseCommands.forEach((command) => {
      commandEntries.push([command.usage, command.description]);
    });

    trailingCommands.forEach((command) => {
      commandEntries.push([command.usage, command.description]);
    });

    const keyEntries: Array<[string, string]> = [
      ["shift+tab", "cycle reasoning effort"],
      ["ctrl+p", "cycle personality"],
      ["ctrl+t", "toggle thoughts visibility"],
      ["ctrl+o", "toggle compact tool UI"],
      ["ctrl+s", "stash input to clipboard"],
      ["ctrl+y", "toggle voice recording"],
      ["ctrl+enter", "steer running assistant with editor input"],
      ["alt+up", "cancel pending messages into editor"],
      ["enter x2", "retry last response"],
      ["esc x2", "clear current prompt"],
      ["esc", "interrupt active task"],
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
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/help") return null;
      return { type: "help", extra };
    },
    run: (ctx) => ctx.help(),
  });

  registry.register({
    id: "exit",
    usage: "/exit",
    description: "exit tau",
    autocompleteDescription: "exit tau",
    argument: "none",
    section: "base",
    allowDuringStreaming: true,
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/exit") return null;
      return { type: "exit", extra };
    },
    run: (ctx) => ctx.exit(),
  });

  registry.register({
    id: "new",
    usage: "/new",
    description: "new session",
    autocompleteDescription: "new session",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/new") return null;
      return { type: "new", extra };
    },
    run: (ctx) => ctx.newSession(),
  });

  registry.register({
    id: "rewind",
    usage: "/rewind",
    description: "rewind context to an earlier user message",
    autocompleteDescription: "rewind context to a selected user message",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/rewind") return null;
      return { type: "rewind", extra };
    },
    run: (ctx) => ctx.rewind(),
  });

  registry.register({
    id: "diff",
    usage: "/diff [git diff args...]",
    description: "open the local diff review tool for the session diff",
    autocompleteDescription: "open diff review for git diff args",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/diff") return null;
      return { type: "diff", argsText: extra ?? "", extra };
    },
    run: (ctx, command) => ctx.diff(command.argsText),
  });

  registry.register({
    id: "compactSummaryOnly",
    usage: "/compact:summary-only",
    description: "summarize and start new session",
    autocompleteDescription: "compact history to a summary",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/compact:summary-only") return null;
      return { type: "compactSummaryOnly", extra };
    },
    run: (ctx, command) => ctx.compactSummaryOnly(command.extra),
  });

  registry.register({
    id: "compactSummaryAndLast",
    usage: "/compact:summary-and-last",
    description: "summarize and include previous last assistant message",
    autocompleteDescription: "compact history, keep last assistant message",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/compact:summary-and-last") return null;
      return { type: "compactSummaryAndLast", extra };
    },
    run: (ctx, command) => ctx.compactSummaryAndLast(command.extra),
  });

  registry.register({
    id: "pruneEarliest",
    usage: "/prune:earliest",
    description: "prune earliest tool results from context",
    autocompleteDescription: "prune earliest tool results",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/prune:earliest") return null;
      return { type: "pruneEarliest", extra };
    },
    run: (ctx, command) => ctx.pruneEarliest(command.extra),
  });

  registry.register({
    id: "pruneLargest",
    usage: "/prune:largest",
    description: "prune largest tool results from context",
    autocompleteDescription: "prune largest tool results",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/prune:largest") return null;
      return { type: "pruneLargest", extra };
    },
    run: (ctx, command) => ctx.pruneLargest(command.extra),
  });

  registry.register({
    id: "pruneSmart",
    usage: "/prune:smart",
    description: "prune tool results using model selection",
    autocompleteDescription: "prune tool results with model selection",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/prune:smart") return null;
      return { type: "pruneSmart", extra };
    },
    run: (ctx, command) => ctx.pruneSmart(command.extra),
  });

  registry.register({
    id: "reload",
    usage: "/reload",
    description: "reload prompts, skills, themes, and AGENTS.md",
    autocompleteDescription: "reload prompts, skills, themes, and AGENTS.md",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/reload") return null;
      return { type: "reload", extra };
    },
    run: (ctx) => ctx.reload(),
  });

  registry.register({
    id: "listen",
    usage: "/listen",
    description: "start voice recording and transcription",
    autocompleteDescription: "start voice recording",
    argument: "none",
    section: "base",
    allowDuringStreaming: true,
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/listen") return null;
      return { type: "listen", extra };
    },
    run: (ctx) => ctx.listen(),
  });

  registry.register({
    id: "speak",
    usage: "/speak",
    description: "speak the last assistant message aloud",
    autocompleteDescription: "speak the last assistant message",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/speak") return null;
      return { type: "speak", extra };
    },
    run: (ctx) => ctx.speak(),
  });

  registry.register({
    id: "copyText",
    usage: "/copy:text",
    description: "copy last assistant message",
    autocompleteDescription: "copy last assistant message",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/copy:text") return null;
      return { type: "copyText", extra };
    },
    run: (ctx) => ctx.copyText(),
  });

  registry.register({
    id: "copyCode",
    usage: "/copy:code",
    description: "copy code blocks from last assistant message",
    autocompleteDescription: "copy code blocks from last assistant message",
    argument: "none",
    section: "base",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      if (command !== "/copy:code") return null;
      return { type: "copyCode", extra };
    },
    run: (ctx) => ctx.copyCode(),
  });

  registry.register({
    id: "persona",
    usage: "/persona:<id>",
    description: "switch persona",
    argument: "persona",
    section: "trailing",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      const match = command.match(/^\/persona:(.+)$/i);
      const id = match?.[1]?.trim() ?? "";
      if (!id) return null;
      return { type: "persona", id, extra };
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
      const { command, extra } = splitCommandInput(raw);
      const match = command.match(/^\/prompt:(.+)$/i);
      const id = match?.[1]?.trim() ?? "";
      if (!id) return null;
      return { type: "prompt", id, extra };
    },
    run: (ctx, command) => ctx.prompt(command.id),
  });

  registry.register({
    id: "theme",
    usage: "/theme:<id>",
    description: "switch theme",
    argument: "theme",
    section: "trailing",
    parse: (raw) => {
      const { command, extra } = splitCommandInput(raw);
      const match = command.match(/^\/theme:(.+)$/i);
      const id = match?.[1]?.trim() ?? "";
      if (!id) return null;
      return { type: "theme", id, extra };
    },
    run: (ctx, command) => ctx.theme(command.id),
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
