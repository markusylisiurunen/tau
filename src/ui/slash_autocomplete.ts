import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "../utils/fuzzy.js";

export interface PersonaSuggestion {
  id: string;
  label?: string;
}

/**
 * Autocomplete provider for slash commands only.
 * Supports:
 *   /help
 *   /copy
 *   /persona:<id>
 *
 * No file/path completion.
 */
export class SlashAutocompleteProvider implements AutocompleteProvider {
  constructor(private personas: () => PersonaSuggestion[]) {}

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);

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

    // Command name completion (no persona argument context).
    // Auto-generate /persona:<id> entries for convenience.
    const staticCommands: Array<{ value: string; label: string; description: string }> = [
      { value: "help", label: "help", description: "Show help" },
      { value: "copy", label: "copy", description: "Copy last assistant message" },
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

    const filteredCandidates = fuzzyFilter(candidates, afterSlash, (c) => c.searchText);
    const items = filteredCandidates.map((c) => c.item);

    if (items.length === 0) return null;
    return { items, prefix: afterSlash };
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

    // If we're completing a persona argument, prefix does not include "persona:"
    const isPersonaArg = beforePrefix.toLowerCase().endsWith("/persona:");

    let insert: string;
    if (isPersonaArg) {
      insert = item.value;
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
