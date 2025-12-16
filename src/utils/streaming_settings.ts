import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { z } from "zod";

const StreamingSettingsSchema = z
  .record(z.string(), z.unknown())
  .transform((data): SimpleStreamOptions => {
    const result = { ...data } as Record<string, unknown>;

    // Handle reasoning field: convert "none" to undefined for pi-ai compatibility
    if (result.reasoning === undefined || result.reasoning === "none") {
      delete result.reasoning;
    }

    return result as unknown as SimpleStreamOptions;
  });

export function parseStreamingSettings(settings: Record<string, unknown>): SimpleStreamOptions {
  return StreamingSettingsSchema.parse(settings);
}
