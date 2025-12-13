import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "../utils/fuzzy.js";

export interface PersonaSuggestion {
  id: string;
  label?: string;
}

export interface PromptSuggestion {
  id: string;
  label?: string;
}

const STATIC_COMMANDS = [
  { value: "help", label: "help", description: "show help" },
  { value: "new", label: "new", description: "new session" },
  { value: "fork", label: "fork", description: "summarize and start new session" },
  { value: "copy", label: "copy", description: "copy last assistant message" },
  { value: "tool:none", label: "tool:none", description: "disable all tools" },
  { value: "tool:read", label: "tool:read", description: "allow read-only tools" },
  { value: "tool:all", label: "tool:all", description: "allow all tools" },
];

const TOOL_OPTIONS = [
  { id: "none", description: "disable all tools" },
  { id: "read", description: "allow read-only tools" },
  { id: "all", description: "allow all tools" },
];

export class SlashAutocompleteProvider implements AutocompleteProvider {
  private getPersonas: () => PersonaSuggestion[];
  private getPrompts: () => PromptSuggestion[];
  private getFiles: () => string[];

  constructor(
    personas: () => PersonaSuggestion[],
    prompts: () => PromptSuggestion[] = () => [],
    files: () => string[] = () => [],
  ) {
    this.getPersonas = personas;
    this.getPrompts = prompts;
    this.getFiles = files;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);

    const fileSuggestions = this.getFileSuggestions(beforeCursor);
    if (fileSuggestions) return fileSuggestions;

    if (!beforeCursor.startsWith("/")) return null;

    const afterSlash = beforeCursor.slice(1);

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

    const insert = this.buildInsertText(item, prefix, beforePrefix);
    const newLine = beforePrefix + insert + afterCursor;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;

    return {
      lines: newLines,
      cursorLine,
      cursorCol: beforePrefix.length + insert.length,
    };
  }

  private getFileSuggestions(
    beforeCursor: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const fileMatch = beforeCursor.match(/(?:^|[\t ])(@[^\t ]*)$/);
    if (!fileMatch) return null;

    const token = fileMatch[1] ?? "@";
    const query = token.slice(1);
    const filtered = fuzzyFilter(this.getFiles(), query, (p) => p);
    const items = filtered.slice(0, 25).map((p) => ({ value: p, label: p }));

    if (items.length === 0) return null;
    return { items, prefix: token };
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

    const toolMatch = afterSlash.match(/^tool:(.*)$/i);
    if (toolMatch) {
      return this.buildToolSuggestions(toolMatch[1] ?? "");
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

  private buildToolSuggestions(
    argPrefix: string,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const filtered = fuzzyFilter(TOOL_OPTIONS, argPrefix, (o) => `${o.id} ${o.description}`);
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

    for (const cmd of STATIC_COMMANDS) {
      candidates.push({
        item: { value: cmd.value, label: cmd.label, description: cmd.description },
        searchText: cmd.value,
      });
    }

    for (const p of this.getPersonas()) {
      const full = `persona:${p.id}`;
      candidates.push({
        item: {
          value: full,
          label: full,
          description: p.label ? `switch to ${p.label}` : "switch persona",
        },
        searchText: `${p.id} ${p.label ?? ""} ${full}`,
      });
    }

    for (const t of this.getPrompts()) {
      const full = `prompt:${t.id}`;
      candidates.push({
        item: {
          value: full,
          label: full,
          description: t.label ? `insert ${t.label}` : "insert prompt template",
        },
        searchText: `${t.id} ${t.label ?? ""} ${full}`,
      });
    }

    const filteredCandidates = fuzzyFilter(candidates, afterSlash, (c) => c.searchText);
    const items = filteredCandidates.map((c) => c.item);

    if (items.length === 0) return null;
    return { items, prefix: `/${afterSlash}` };
  }

  private buildInsertText(item: AutocompleteItem, prefix: string, beforePrefix: string): string {
    if (prefix.startsWith("@")) {
      return `@${item.value}`;
    }

    const lowerBeforePrefix = beforePrefix.toLowerCase();
    const isArgCompletion =
      lowerBeforePrefix.endsWith("/persona:") ||
      lowerBeforePrefix.endsWith("/prompt:") ||
      lowerBeforePrefix.endsWith("/tool:");

    if (isArgCompletion) {
      return item.value;
    }

    if (prefix.startsWith("/") || beforePrefix.endsWith("/")) {
      return prefix.startsWith("/") ? `/${item.value}` : item.value;
    }

    return `/${item.value}`;
  }
}
