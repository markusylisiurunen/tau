import type { ZodError, ZodType } from "zod";

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function parseToolArgs<T>(
  schema: ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}
