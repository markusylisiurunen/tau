import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { CommandRegistry } from "../../core/commands/index.js";
import { fuzzyFilter } from "../../core/utils/fuzzy.js";
import type { TuiAutocompleteItem } from "./autocomplete_item.js";

const MENTION_TOKEN_REGEX = /(?:^|[\t ])(@[^\t ]*)$/;

type MentionKind = "skill" | "agent";

function sortAutocompleteItems(items: TuiAutocompleteItem[]): TuiAutocompleteItem[] {
  return [...items].sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
    return labelOrder !== 0 ? labelOrder : left.value.localeCompare(right.value);
  });
}

function filterAutocompleteItems(
  items: TuiAutocompleteItem[],
  query: string,
): TuiAutocompleteItem[] {
  return fuzzyFilter(sortAutocompleteItems(items), query, (item) => item.label);
}

export function getMentionAutocompleteToken(beforeCursor: string): string | null {
  const match = beforeCursor.match(MENTION_TOKEN_REGEX);
  return match?.[1] ?? null;
}

export function getFileAutocompleteToken(beforeCursor: string): string | null {
  const token = getMentionAutocompleteToken(beforeCursor);
  if (!token?.startsWith("@") || token.startsWith("@@")) return null;
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

type MentionKindSuggestion = {
  kind: MentionKind;
  description: string;
};

export class SlashAutocompleteProvider<Ctx = unknown> implements AutocompleteProvider {
  private commandRegistry: CommandRegistry<Ctx>;
  private getPersonas: () => PersonaSuggestion[];
  private getPrompts: () => PromptSuggestion[];
  private getThemes: () => ThemeSuggestion[];
  private getPaths: (query: string, limit: number, signal: AbortSignal) => Promise<string[]>;
  private getSkills: () => string[];
  private getAgents: () => string[];

  constructor(
    commandRegistry: CommandRegistry<Ctx>,
    personas: () => PersonaSuggestion[],
    prompts: () => PromptSuggestion[] = () => [],
    themes: () => ThemeSuggestion[] = () => [],
    paths: (
      query: string,
      limit: number,
      signal: AbortSignal,
    ) => Promise<string[]> = async () => [],
    skills: () => string[] = () => [],
    agents: () => string[] = () => [],
  ) {
    this.commandRegistry = commandRegistry;
    this.getPersonas = personas;
    this.getPrompts = prompts;
    this.getThemes = themes;
    this.getPaths = paths;
    this.getSkills = skills;
    this.getAgents = agents;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: TuiAutocompleteItem[]; prefix: string } | null> {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);

    const mentionSuggestions = await this.getMentionSuggestions(beforeCursor, _options.signal);
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
    item: TuiAutocompleteItem,
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
    signal: AbortSignal,
  ): Promise<{ items: TuiAutocompleteItem[]; prefix: string } | null> {
    const token = getMentionAutocompleteToken(beforeCursor);
    if (!token) return Promise.resolve(null);

    if (token.startsWith("@@")) {
      return Promise.resolve(this.getTypedMentionSuggestions(token));
    }

    return this.getFileMentionSuggestions(token, signal);
  }

  private async getFileMentionSuggestions(
    token: string,
    signal: AbortSignal,
  ): Promise<{ items: TuiAutocompleteItem[]; prefix: string } | null> {
    const valuePrefix = token.slice(1);
    const paths = await this.getPaths(valuePrefix, 25, signal);
    if (signal.aborted) return null;
    const items = paths.map((path) => ({ value: path, label: path }));

    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  private getTypedMentionSuggestions(
    token: string,
  ): { items: TuiAutocompleteItem[]; prefix: string } | null {
    const body = token.slice(2);
    const colonIndex = body.indexOf(":");

    if (colonIndex === -1) {
      return this.getMentionKindSuggestions(token, body);
    }

    const kind = body.slice(0, colonIndex) as MentionKind;
    const valuePrefix = body.slice(colonIndex + 1);
    return this.getMentionEntrySuggestions(kind, valuePrefix, token);
  }

  private getMentionKindSuggestions(
    token: string,
    kindPrefix: string,
  ): { items: TuiAutocompleteItem[]; prefix: string } | null {
    const kinds = this.getAvailableMentionKinds();
    if (kinds.length === 0) return null;

    const items = filterAutocompleteItems(
      kinds.map((kind) => ({
        value: `${kind.kind}:`,
        label: kind.kind,
        description: kind.description,
      })),
      kindPrefix,
    );

    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  private getMentionEntrySuggestions(
    kind: MentionKind,
    valuePrefix: string,
    token: string,
  ): { items: TuiAutocompleteItem[]; prefix: string } | null {
    const source = this.getMentionSource(kind);
    if (!source) return null;

    const items = filterAutocompleteItems(
      source.map((value) => ({ value, label: value })),
      valuePrefix,
    ).slice(0, 25);

    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  private getAvailableMentionKinds(): MentionKindSuggestion[] {
    const kinds: MentionKindSuggestion[] = [];
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
      case "skill":
        return this.getSkills();
      case "agent":
        return this.getAgents();
    }
  }

  private getArgumentSuggestions(
    afterSlash: string,
  ): { items: TuiAutocompleteItem[]; prefix: string } | null {
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

    return null;
  }

  private buildArgSuggestions(
    argPrefix: string,
    suggestions: Array<{ id: string; label?: string }>,
  ): { items: TuiAutocompleteItem[]; prefix: string } | null {
    const sortedSuggestions = [...suggestions].sort((left, right) =>
      left.id.localeCompare(right.id, undefined, { sensitivity: "base" }),
    );
    const filtered = fuzzyFilter(sortedSuggestions, argPrefix, (suggestion) => suggestion.id);
    const showDescriptions = filtered.every((p) => p.label && p.label !== p.id);
    const items = filtered.map((p) => ({
      value: p.id,
      label: p.id,
      ...(showDescriptions && p.label ? { description: p.label } : {}),
      autocompleteAction: "submit" as const,
    }));

    if (items.length === 0) return null;
    return { items, prefix: argPrefix };
  }

  private getCommandSuggestions(
    afterSlash: string,
  ): { items: TuiAutocompleteItem[]; prefix: string } | null {
    const candidates: TuiAutocompleteItem[] = [];

    for (const command of this.commandRegistry.list()) {
      const usage = command.usage.startsWith("/") ? command.usage.slice(1) : command.usage;
      const description = command.autocompleteDescription;

      if (command.argument !== "none") {
        const hasChildren =
          command.argument === "persona"
            ? this.getPersonas().length > 0
            : command.argument === "prompt"
              ? this.getPrompts().length > 0
              : this.getThemes().length > 0;
        if (!hasChildren) continue;

        candidates.push({
          value: `${command.argument}:`,
          label: command.argument,
          ...(description ? { description } : {}),
          autocompleteAction: "navigate",
        });
        continue;
      }

      const value = usage.split(/\s+/, 1)[0] ?? usage;
      candidates.push({
        value,
        label: value,
        ...(description ? { description } : {}),
        autocompleteAction: "submit",
      });
    }

    const items = filterAutocompleteItems(candidates, afterSlash);

    if (items.length === 0) return null;
    return { items, prefix: `/${afterSlash}` };
  }

  private buildInsertText(item: TuiAutocompleteItem, prefix: string, beforePrefix: string): string {
    if (prefix.startsWith("@@")) {
      const mentionMatch = prefix.match(/^@@([^:\s]+):/);
      if (mentionMatch) {
        return `@@${mentionMatch[1]}:${item.value}`;
      }
      return `@@${item.value}`;
    }

    if (prefix.startsWith("@")) {
      return `@${item.value}`;
    }

    const lowerBeforePrefix = beforePrefix.toLowerCase();
    const isArgCompletion =
      lowerBeforePrefix.endsWith("/persona:") ||
      lowerBeforePrefix.endsWith("/prompt:") ||
      lowerBeforePrefix.endsWith("/theme:");

    if (isArgCompletion) {
      return item.value;
    }

    if (prefix.startsWith("/") || beforePrefix.endsWith("/")) {
      return prefix.startsWith("/") ? `/${item.value}` : item.value;
    }

    return `/${item.value}`;
  }
}
