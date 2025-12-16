import type { ZodError } from "zod";

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
