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

export interface BashSuggestion {
  id: string;
  description?: string;
}

// biome-ignore format: keep array items on single lines for readability
const STATIC_COMMANDS = [
  { value: "help", label: "help", description: "show help" },
  { value: "new", label: "new", description: "new session" },
  { value: "fork:only-summary", label: "fork:only-summary", description: "fork with compressed summary" },
  { value: "fork:with-last-turn", label: "fork:with-last-turn", description: "fork with summary and previous last turn" },
  { value: "reload", label: "reload", description: "reload personas and prompts from disk" },
  { value: "copy", label: "copy", description: "copy last assistant message" },
  { value: "copy:code", label: "copy:code", description: "copy code blocks from last assistant message" },
  { value: "risk:none", label: "risk:none", description: "disable all tools" },
  { value: "risk:read-only", label: "risk:read-only", description: "allow read-only tools" },
  { value: "risk:read-write", label: "risk:read-write", description: "allow all tools" },
];

const RISK_OPTIONS = [
  { id: "none", description: "disable all tools" },
  { id: "read-only", description: "allow read-only tools" },
  { id: "read-write", description: "allow all tools" },
];

export class SlashAutocompleteProvider implements AutocompleteProvider {
  private getPersonas: () => PersonaSuggestion[];
  private getPrompts: () => PromptSuggestion[];
  private getBashCommands: () => BashSuggestion[];
  private getFiles: () => string[];

  constructor(
    personas: () => PersonaSuggestion[],
    prompts: () => PromptSuggestion[] = () => [],
    bashCommands: () => BashSuggestion[] = () => [],
    files: () => string[] = () => [],
  ) {
    this.getPersonas = personas;
    this.getPrompts = prompts;
    this.getBashCommands = bashCommands;
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

    const riskMatch = afterSlash.match(/^risk:(.*)$/i);
    if (riskMatch) {
      return this.buildRiskSuggestions(riskMatch[1] ?? "");
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
    const filtered = fuzzyFilter(RISK_OPTIONS, argPrefix, (o) => `${o.id} ${o.description}`);
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

    for (const b of this.getBashCommands()) {
      const full = `bash:${b.id}`;
      candidates.push({
        item: {
          value: full,
          label: full,
          description: b.description ? b.description : "run saved bash command",
        },
        searchText: `${b.id} ${b.description ?? ""} ${full}`,
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
      lowerBeforePrefix.endsWith("/risk:");

    if (isArgCompletion) {
      return item.value;
    }

    if (prefix.startsWith("/") || beforePrefix.endsWith("/")) {
      return prefix.startsWith("/") ? `/${item.value}` : item.value;
    }

    return `/${item.value}`;
  }
}
