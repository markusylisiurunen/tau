export type JwtPayload = Record<string, unknown>;

export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1] ?? "";
  const decoded = decodeBase64Url(payload);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string | null {
  try {
    let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4 !== 0) {
      normalized += "=";
    }
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return null;
  }
}
