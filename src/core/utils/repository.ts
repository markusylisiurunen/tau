export function normalizeRepositoryReference(
  value: string,
  options: { defaultHost?: string } = {},
): string | undefined {
  const reference = value.trim();
  if (!reference) return undefined;

  let host: string | undefined;
  let path: string | undefined;

  if (reference.includes("://")) {
    try {
      const url = new URL(reference);
      host = url.host;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    const scp = reference.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) {
      host = scp[1];
      path = scp[2];
    } else {
      const slash = reference.indexOf("/");
      if (slash > 0 && reference.slice(0, slash).includes(".")) {
        host = reference.slice(0, slash);
        path = reference.slice(slash + 1);
      } else if (options.defaultHost && slash > 0) {
        host = options.defaultHost;
        path = reference;
      }
    }
  }

  const normalizedHost = host?.trim().toLowerCase();
  const normalizedPath = path
    ?.trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  if (!normalizedHost || !normalizedPath) return undefined;
  return `${normalizedHost}/${normalizedPath}`;
}
