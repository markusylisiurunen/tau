// Binary paths travel separately from the JSON value so arbitrary JSON objects
// cannot be mistaken for byte arrays.
export function encodeBridgeValue(value: unknown, omitUndefined: boolean): string {
  if (value instanceof Uint8Array) return `[${JSON.stringify(toBase64(value))},[[]]]`;
  const paths = new WeakMap<object, string[]>();
  const binary: string[][] = [];
  let root = true;
  const json = JSON.stringify(value, function (key, item: unknown) {
    const path = root ? [] : [...(paths.get(this) ?? []), key];
    root = false;
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
    if (!item || typeof item !== "object") return item;
    const encoded = encodeChildBytes(item, path, binary);
    paths.set(encoded, path);
    return encoded;
  });
  return `[${json},${JSON.stringify(binary)}]`;
}

// JSON.stringify calls toJSON on a property before the replacer sees it, which turns a
// Buffer into an array of numbers. Encoding the bytes one level up avoids that copy.
function encodeChildBytes(item: object, path: string[], binary: string[][]): object {
  let copy: Record<string, unknown> | unknown[] | undefined;
  for (const [key, child] of Object.entries(item)) {
    if (!(child instanceof Uint8Array)) continue;
    copy ??= Array.isArray(item) ? [...item] : { ...item };
    (copy as Record<string, unknown>)[key] = toBase64(child);
    binary.push([...path, key]);
  }
  return copy ?? item;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
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
