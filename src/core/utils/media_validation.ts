import type { z } from "zod";

export function parseMediaJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function mediaValidationConstraint(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_value":
      return `use ${issue.values.map((value) => JSON.stringify(value)).join(" or ")}`;
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "unrecognized_keys":
      return `remove unknown fields: ${issue.keys.join(", ")}`;
    case "too_small":
      return `must contain at least ${issue.minimum} ${issue.origin === "array" ? "item" : "character"}${issue.minimum === 1 ? "" : "s"}`;
    case "invalid_key":
      return `invalid field name: ${issue.issues.map(mediaValidationConstraint).join("; ")}`;
    default:
      return issue.message;
  }
}

export async function readMediaResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("provider returned an empty response");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        throw new Error("provider response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
