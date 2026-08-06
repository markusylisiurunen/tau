import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type TuiAutocompleteItem = AutocompleteItem & {
  autocompleteAction?: "navigate" | "submit";
};
