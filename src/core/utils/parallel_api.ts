import { z } from "zod";

export const PARALLEL_API_BASE_URL = "https://api.parallel.ai";
export const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

const parallelApiErrorMessageSchema = z
  .union([
    z
      .object({
        type: z.literal("error"),
        error: z.object({
          message: z.string(),
        }),
      })
      .transform((payload) => payload.error.message),
    z
      .object({
        message: z.string(),
      })
      .transform((payload) => payload.message),
  ])
  .transform((message) => message.trim())
  .pipe(z.string().min(1));

export function extractParallelErrorMessage(raw: unknown): string | undefined {
  const parsed = parallelApiErrorMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
