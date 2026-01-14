import { z } from "zod";

export const PARALLEL_API_BASE_URL = "https://api.parallel.ai";
export const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

const parallelApiErrorSchema = z.union([
  z.object({
    type: z.literal("error"),
    error: z.object({
      message: z.string(),
    }),
  }),
  z.object({
    message: z.string(),
  }),
]);

type ParallelApiError = z.infer<typeof parallelApiErrorSchema>;

export function extractParallelErrorMessage(raw: unknown): string | undefined {
  const parsed = parallelApiErrorSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const obj: ParallelApiError = parsed.data;

  if ("type" in obj && obj.type === "error") {
    const msg = obj.error.message.trim();
    return msg ? msg : undefined;
  }

  if ("message" in obj) {
    const msg = obj.message.trim();
    return msg ? msg : undefined;
  }

  return undefined;
}
