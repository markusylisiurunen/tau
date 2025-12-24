import type { StreamOptions } from "@markusylisiurunen/iota";
import { z } from "zod";

const StreamingSettingsSchema = z
  .record(z.string(), z.unknown())
  .transform((data): StreamOptions => {
    return { ...data } as StreamOptions;
  });

export function parseStreamingSettings(settings: Record<string, unknown>): StreamOptions {
  return StreamingSettingsSchema.parse(settings);
}
