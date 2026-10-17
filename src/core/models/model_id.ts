export function parseModelId(raw: string): { provider: string; modelId: string } | undefined {
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator >= raw.length - 1 || /\s/.test(raw)) {
    return undefined;
  }

  const provider = raw.slice(0, separator);
  if (provider.includes(":")) {
    return undefined;
  }

  return { provider, modelId: raw.slice(separator + 1) };
}
