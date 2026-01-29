import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import type { CommandRegistry } from "../../core/commands/index.js";
import { getRiskLevelAutocompleteOptions } from "../../core/commands/index.js";
import type { RiskLevel } from "../../core/types.js";
import { fuzzyFilter } from "../../core/utils/fuzzy.js";

const MENTION_TOKEN_REGEX = /(?:^|[\t ])(@[^\t ]*)$/;

type MentionKind = "file" | "skill" | "agent";

export function getMentionAutocompleteToken(beforeCursor: string): string | null {
  const match = beforeCursor.match(MENTION_TOKEN_REGEX);
  return match?.[1] ?? null;
}

export function getFileAutocompleteToken(beforeCursor: string): string | null {
  const token = getMentionAutocompleteToken(beforeCursor);
  if (!token?.startsWith("@file:")) return null;
  return token;
}

export interface PersonaSuggestion {
  id: string;
  label?: string;
}

export interface PromptSuggestion {
  id: string;
  label?: string;
}

export interface ThemeSuggestion {
  id: string;
  label?: string;
}

export interface BashSuggestion {
  id: string;
  description?: string;
}

type MentionKindSuggestion = {
  kind: MentionKind;
  description: string;
};

export class SlashAutocompleteProvider<Ctx = unknown> implements AutocompleteProvider {
  private commandRegistry: CommandRegistry<Ctx>;
  private getPersonas: () => PersonaSuggestion[];
  private getPrompts: () => PromptSuggestion[];
  private getThemes: () => ThemeSuggestion[];
  private getBashCommands: () => BashSuggestion[];
  private getFiles: () => string[];
  private getSkills: () => string[];
  private getAgents: () => string[];
  private getRiskLevels: () => RiskLevel[];

  constructor(
    commandRegistry: CommandRegistry<Ctx>,
    personas: () => PersonaSuggestion[],
    prompts: () => PromptSuggestion[] = () => [],
    themes: () => ThemeSuggestion[] = () => [],
    bashCommands: () => BashSuggestion[] = () => [],
    files: () => string[] = () => [],
    skills: () => string[] = () => [],
    agents: () => string[] = () => [],
    riskLevels: () => RiskLevel[] = () => ["read-only", "read-write"],
  ) {
    this.commandRegistry = commandRegistry;
    this.getPersonas = personas;
    this.getPrompts = prompts;
    this.getThemes = themes;
    this.getBashCommands = bashCommands;
    this.getFiles = files;
    this.getSkills = skills;
    this.getAgents = agents;
    this.getRiskLevels = riskLevels;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);

    const mentionSuggestions = this.getMentionSuggestions(beforeCursor);
    if (mentionSuggestions) return mentionSuggestions;

    if (!beforeCursor.startsWith("/")) return null;

    const afterSlash = beforeCursor.slice(1);
    if (afterSlash.includes(" ") || afterSlash.includes("\t")) {
      return null;
    }

    const argSuggestions = this.getArgumentSuggestions(afterSlash);
    if (argSuggestions) return argSuggestions;

    return this.getCommandSuggestions(afterSlash);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const beforePrefix = line.slice(0, cursorCol - prefix.length);
    const afterCursor = line.slice(cursorCol);

    let insert = this.buildInsertText(item, prefix, beforePrefix);

    if (prefix.startsWith("@") && !insert.endsWith(":")) {
      if (afterCursor.length > 0 && !/^\s/.test(afterCursor)) {
        insert += " ";
      } else if (afterCursor.length === 0) {
        insert += " ";
      }
    }

    const newLine = beforePrefix + insert + afterCursor;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;

    return {
      lines: newLines,
      cursorLine,
      cursorCol: beforePrefix.length + insert.length,
    };
  }

  private getMentionSuggestions(
    beforeCursor: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const token = getMentionAutocompleteToken(beforeCursor);
    if (!token) return null;

    const colonIndex = token.indexOf(":");
    if (colonIndex === -1) {
      return this.getMentionKindSuggestions(token);
    }

    const kind = token.slice(1, colonIndex) as MentionKind;
    const valuePrefix = token.slice(colonIndex + 1);
    return this.getMentionEntrySuggestions(kind, valuePrefix, token);
  }

  private getMentionKindSuggestions(
    token: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const kindPrefix = token.slice(1);
    const kinds = this.getAvailableMentionKinds();
    if (kinds.length === 0) return null;

    const filtered = fuzzyFilter(kinds, kindPrefix, (k) => `${k.kind} ${k.description}`);
    const items = filtered.map((k) => ({
      value: `${k.kind}:`,
      label: k.kind,
      description: k.description,
    }));

    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  private getMentionEntrySuggestions(
    kind: MentionKind,
    valuePrefix: string,
    token: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const source = this.getMentionSource(kind);
    if (!source) return null;

    const filtered = fuzzyFilter(source, valuePrefix, (p) => p);
    const items = filtered.slice(0, 25).map((p) => ({ value: p, label: p }));

    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  private getAvailableMentionKinds(): MentionKindSuggestion[] {
    const kinds: MentionKindSuggestion[] = [];
    if (this.getFiles().length > 0) {
      kinds.push({ kind: "file", description: "project files" });
    }
    if (this.getSkills().length > 0) {
      kinds.push({ kind: "skill", description: "available skills" });
    }
    if (this.getAgents().length > 0) {
      kinds.push({ kind: "agent", description: "available sub-agents" });
    }
    return kinds;
  }

  private getMentionSource(kind: MentionKind): string[] | null {
    switch (kind) {
      case "file":
        return this.getFiles();
      case "skill":
        return this.getSkills();
      case "agent":
        return this.getAgents();
    }
  }

  private getArgumentSuggestions(
    afterSlash: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const personaMatch = afterSlash.match(/^persona:(.*)$/i);
    if (personaMatch) {
      return this.buildArgSuggestions(personaMatch[1] ?? "", this.getPersonas());
    }

    const promptMatch = afterSlash.match(/^prompt:(.*)$/i);
    if (promptMatch) {
      return this.buildArgSuggestions(promptMatch[1] ?? "", this.getPrompts());
    }

    const themeMatch = afterSlash.match(/^theme:(.*)$/i);
    if (themeMatch) {
      return this.buildArgSuggestions(themeMatch[1] ?? "", this.getThemes());
    }

    const riskMatch = afterSlash.match(/^risk:(.*)$/i);
    if (riskMatch) {
      return this.buildRiskSuggestions(riskMatch[1] ?? "");
    }

    const bashMatch = afterSlash.match(/^bash:(.*)$/i);
    if (bashMatch) {
      return this.buildArgSuggestions(
        bashMatch[1] ?? "",
        this.getBashCommands().map((b) => ({ id: b.id, label: b.description })),
      );
    }

    return null;
  }

  private buildArgSuggestions(
    argPrefix: string,
    suggestions: Array<{ id: string; label?: string }>,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const filtered = fuzzyFilter(suggestions, argPrefix, (p) => `${p.id} ${p.label ?? ""}`);
    const items = filtered.map((p) => ({
      value: p.id,
      label: p.id,
      description: p.label,
    }));

    if (items.length === 0) return null;
    return { items, prefix: argPrefix };
  }

  private buildRiskSuggestions(
    argPrefix: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const options = getRiskLevelAutocompleteOptions(this.getRiskLevels());
    const filtered = fuzzyFilter(options, argPrefix, (o) => `${o.id} ${o.description}`);
    const items = filtered.map((o) => ({
      value: o.id,
      label: o.id,
      description: o.description,
    }));

    if (items.length === 0) return null;
    return { items, prefix: argPrefix };
  }

  private getCommandSuggestions(
    afterSlash: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const candidates: Array<{ item: AutocompleteItem; searchText: string }> = [];

    const commandInfos = this.commandRegistry.list();

    const addCommandSuggestion = (command: {
      usage: string;
      description: string;
      autocompleteDescription?: string;
    }): void => {
      const usage = command.usage.startsWith("/") ? command.usage.slice(1) : command.usage;
      const value = usage.split(/\s+/, 1)[0] ?? usage;
      if (!value) return;
      const description = command.autocompleteDescription ?? command.description;
      candidates.push({
        item: { value, label: value, description },
        searchText: `${usage} ${description}`,
      });
    };

    for (const command of commandInfos) {
      if (command.argument !== "none") continue;
      addCommandSuggestion(command);
    }

    const riskCommand = commandInfos.find((command) => command.argument === "risk");
    if (riskCommand) {
      addCommandSuggestion(riskCommand);
    }

    const personaCommand = commandInfos.find((command) => command.argument === "persona");
    if (personaCommand) {
      addCommandSuggestion(personaCommand);
    }

    const promptCommand = commandInfos.find((command) => command.argument === "prompt");
    if (promptCommand) {
      addCommandSuggestion(promptCommand);
    }

    const themeCommand = commandInfos.find((command) => command.argument === "theme");
    if (themeCommand && this.getThemes().length > 0) {
      addCommandSuggestion(themeCommand);
    }

    const bashCommand = commandInfos.find((command) => command.argument === "bash");
    if (bashCommand) {
      addCommandSuggestion(bashCommand);
    }

    const filteredCandidates = fuzzyFilter(candidates, afterSlash, (c) => c.searchText);
    const items = filteredCandidates.map((c) => c.item);

    if (items.length === 0) return null;
    return { items, prefix: `/${afterSlash}` };
  }

  private buildInsertText(item: AutocompleteItem, prefix: string, beforePrefix: string): string {
    if (prefix.startsWith("@")) {
      const mentionMatch = prefix.match(/^@([^:\s]+):/);
      if (mentionMatch) {
        return `@${mentionMatch[1]}:${item.value}`;
      }
      return `@${item.value}`;
    }

    const lowerBeforePrefix = beforePrefix.toLowerCase();
    const isArgCompletion =
      lowerBeforePrefix.endsWith("/persona:") ||
      lowerBeforePrefix.endsWith("/prompt:") ||
      lowerBeforePrefix.endsWith("/theme:") ||
      lowerBeforePrefix.endsWith("/risk:") ||
      lowerBeforePrefix.endsWith("/bash:");

    if (isArgCompletion) {
      return item.value;
    }

    if (prefix.startsWith("/") || beforePrefix.endsWith("/")) {
      return prefix.startsWith("/") ? `/${item.value}` : item.value;
    }

    return `/${item.value}`;
  }
}
