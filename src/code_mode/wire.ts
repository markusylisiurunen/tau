// Binary paths travel separately from the JSON value so arbitrary JSON objects
// cannot be mistaken for byte arrays.
export function encodeBridgeValue(value: unknown, omitUndefined: boolean): string {
  const paths = new WeakMap<object, string[]>();
  const binary: string[][] = [];
  let root = true;
  const json = JSON.stringify(value, function (key, item: unknown) {
    const path = root ? [] : [...(paths.get(this) ?? []), key];
    root = false;
    if (item instanceof Uint8Array) {
      binary.push(path);
      return Buffer.from(item).toString("base64");
    }
    if (item === undefined && omitUndefined && !Array.isArray(this) && path.length > 0) {
      return undefined;
    }
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new TypeError("Code Mode values must be JSON data or Uint8Array bytes");
    }
    if (item && typeof item === "object") paths.set(item, path);
    return item;
  });
  return `[${json},${JSON.stringify(binary)}]`;
}

export function decodeBridgeValue(encoded: string): unknown {
  const envelope = JSON.parse(encoded);
  for (const path of envelope[1]) {
    let parent = envelope;
    let key = "0";
    for (const segment of path) {
      if (!Object.hasOwn(parent, key)) throw new Error("Invalid Code Mode binary path");
      parent = parent[key];
      key = segment;
    }
    if (!Object.hasOwn(parent, key) || typeof parent[key] !== "string") {
      throw new Error("Invalid Code Mode binary value");
    }
    parent[key] = new Uint8Array(Buffer.from(parent[key], "base64"));
  }
  return envelope[0];
}
