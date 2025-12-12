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

/**
 * Autocomplete provider for slash commands only.
 * Supports:
 *   /help
 *   /copy
 *   /persona:<id>
 *   /prompt:<id>
 *   /tool:none
 *   /tool:read
 *   /tool:all
 *   @<file> (fuzzy file path completion)
 *
 * File completion inserts the selected path after "@".
 */
export class SlashAutocompleteProvider implements AutocompleteProvider {
  constructor(
    private personas: () => PersonaSuggestion[],
    private prompts: () => PromptSuggestion[] = () => [],
    private files: () => string[] = () => [],
  ) {}

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);

    // File reference completion: "@foo" (after whitespace or at start of line).
    // Insert as "@path/to/file".
    const fileMatch = beforeCursor.match(/(?:^|[\t ])(@[^\t ]*)$/);
    if (fileMatch) {
      const token = fileMatch[1] ?? "@";
      const query = token.slice(1);
      const all = this.files();
      const filtered = fuzzyFilter(all, query, (p) => p);
      const items = filtered.slice(0, 25).map((p) => ({
        value: p,
        label: p,
      }));
      if (items.length === 0) return null;
      return { items, prefix: token };
    }

    if (!beforeCursor.startsWith("/")) return null;

    const afterSlash = beforeCursor.slice(1);

    // Argument completion for /persona:<prefix>
    const personaMatch = afterSlash.match(/^persona:(.*)$/i);
    if (personaMatch) {
      const argPrefix = personaMatch[1] ?? "";
      const all = this.personas();
      const filtered = fuzzyFilter(all, argPrefix, (p) => `${p.id} ${p.label ?? ""}`);
      const items = filtered.map((p) => ({
        value: p.id,
        label: p.id,
        description: p.label,
      }));
      if (items.length === 0) return null;
      return { items, prefix: argPrefix };
    }

    // Argument completion for /prompt:<prefix>
    const promptMatch = afterSlash.match(/^prompt:(.*)$/i);
    if (promptMatch) {
      const argPrefix = promptMatch[1] ?? "";
      const all = this.prompts();
      const filtered = fuzzyFilter(all, argPrefix, (p) => `${p.id} ${p.label ?? ""}`);
      const items = filtered.map((p) => ({
        value: p.id,
        label: p.id,
        description: p.label,
      }));
      if (items.length === 0) return null;
      return { items, prefix: argPrefix };
    }

    // Argument completion for /tool:<prefix>
    const toolMatch = afterSlash.match(/^tool:(.*)$/i);
    if (toolMatch) {
      const argPrefix = toolMatch[1] ?? "";
      const toolOptions = [
        { id: "none", description: "Block model bash tool calls" },
        { id: "read", description: "Allow read-only model bash tool" },
        { id: "all", description: "Allow all model bash tool" },
      ];
      const filtered = fuzzyFilter(toolOptions, argPrefix, (o) => `${o.id} ${o.description}`);
      const items = filtered.map((o) => ({
        value: o.id,
        label: o.id,
        description: o.description,
      }));
      if (items.length === 0) return null;
      return { items, prefix: argPrefix };
    }

    // Command name completion (no persona argument context).
    // Auto-generate /persona:<id> entries for convenience.
    const staticCommands: Array<{ value: string; label: string; description: string }> = [
      { value: "help", label: "help", description: "Show help" },
      { value: "copy", label: "copy", description: "Copy last assistant message" },
      { value: "tool:none", label: "tool:none", description: "Disable model bash tool" },
      { value: "tool:read", label: "tool:read", description: "Allow read-only model bash tool" },
      { value: "tool:all", label: "tool:all", description: "Allow all model bash tool" },
      { value: "new", label: "new", description: "Clear session" },
    ];

    const candidates: Array<{ item: AutocompleteItem; searchText: string }> = [];

    for (const cmd of staticCommands) {
      candidates.push({
        item: {
          value: cmd.value,
          label: cmd.label,
          description: cmd.description,
        },
        searchText: cmd.value,
      });
    }

    for (const p of this.personas()) {
      const full = `persona:${p.id}`;
      const searchText = `${p.id} ${p.label ?? ""} ${full}`;
      candidates.push({
        item: {
          value: full,
          label: full,
          description: p.label ? `Switch to ${p.label}` : "Switch persona",
        },
        searchText,
      });
    }

    for (const t of this.prompts()) {
      const full = `prompt:${t.id}`;
      const searchText = `${t.id} ${t.label ?? ""} ${full}`;
      candidates.push({
        item: {
          value: full,
          label: full,
          description: t.label ? `Insert ${t.label}` : "Insert prompt template",
        },
        searchText,
      });
    }

    const filteredCandidates = fuzzyFilter(candidates, afterSlash, (c) => c.searchText);
    const items = filteredCandidates.map((c) => c.item);

    if (items.length === 0) return null;
    // Prefix includes the leading "/" so pi-tui treats Enter as slash-submit.
    return { items, prefix: `/${afterSlash}` };
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

    if (prefix.startsWith("@")) {
      const insert = `@${item.value}`;
      const newLine = beforePrefix + insert + afterCursor;
      const newLines = [...lines];
      newLines[cursorLine] = newLine;

      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + insert.length,
      };
    }

    // If we're completing an argument (/persona: or /prompt:), prefix does not include the command.
    const lowerBeforePrefix = beforePrefix.toLowerCase();
    const isArgCompletion =
      lowerBeforePrefix.endsWith("/persona:") ||
      lowerBeforePrefix.endsWith("/prompt:") ||
      lowerBeforePrefix.endsWith("/tool:");

    let insert: string;
    if (isArgCompletion) {
      insert = item.value;
    } else if (prefix.startsWith("/")) {
      // Command completion prefix already included a leading "/".
      insert = `/${item.value}`;
    } else if (beforePrefix.endsWith("/")) {
      insert = item.value;
    } else {
      insert = `/${item.value}`;
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
}
