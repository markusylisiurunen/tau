import { assertNever } from "../utils/never.js";
import { renderHtmlExport } from "./html.js";
import type { ExportEntry, ExportMetadata } from "./types.js";

export type ExportFormat = "html";

export function renderExport(
  format: ExportFormat,
  entries: ExportEntry[],
  metadata?: ExportMetadata,
): string {
  switch (format) {
    case "html":
      return renderHtmlExport(entries, metadata);
    default:
      return assertNever(format);
  }
}
