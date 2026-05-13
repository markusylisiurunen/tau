import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReasoningEffort, ServiceTier } from "../types.js";

export type TauStreamOptions = Omit<SimpleStreamOptions, "reasoning"> & {
  reasoning?: ReasoningEffort;
  interleavedThinking?: boolean;
  serviceTier?: ServiceTier;
};

const StreamingSettingsSchema = z
  .record(z.string(), z.unknown())
  .transform((data): TauStreamOptions => {
    return { ...data } as TauStreamOptions;
  });

export function parseStreamingSettings(settings: Record<string, unknown>): TauStreamOptions {
  return StreamingSettingsSchema.parse(settings);
}
