export type JwtPayload = Record<string, unknown>;

export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const payload = decodeBase64Url(parts[1] ?? "");
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
      "base64",
    ).toString("utf-8");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JwtPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
