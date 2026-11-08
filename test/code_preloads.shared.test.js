import { expect, it, vi } from "vitest";
import { loadCodeProgram } from "../dist/core/tools/code_preloads.js";

function loader(files, signal = new AbortController().signal) {
  const readFileBinary = vi.fn(async (path, { maxBytes }) => {
    if (!(path in files)) throw new Error("missing file");
    const content = Buffer.from(files[path]);
    if (content.length > maxBytes) throw new Error("file too large");
    return { content };
  });
  return {
    readFileBinary,
    load: (source) =>
      loadCodeProgram({ backend: { readFileBinary }, cwd: "/remote", source, signal }),
  };
}

it("resolves a diamond through the backend in dependency order and ignores non-header directives", async () => {
  const { load, readFileBinary } = loader({
    "/remote/main.js":
      "\uFEFF/* header */\n// @preload ./lib/a.js\n// @preload lib/b.js\nprintText('main');\n// @preload missing.js",
    "/remote/lib/a.js": "// @preload ../shared helpers.js\nconst local = 1;",
    "/remote/lib/b.js": "// @preload ../lib/../shared helpers.js\nconst local = 2;",
    "/remote/shared helpers.js": "/*\n// @preload missing.js\n*/\nglobalThis.helpers = {};",
  });
  const result = await load({ file: "main.js" });
  expect(result.sourceName).toBe("/remote/main.js");
  expect(result.preloads.map((source) => source.sourceName)).toEqual([
    "/remote/shared helpers.js",
    "/remote/lib/a.js",
    "/remote/lib/b.js",
  ]);
  expect(readFileBinary).toHaveBeenCalledTimes(4);
});

it("rejects cycles, malformed headers, and missing dependencies before execution", async () => {
  const { load } = loader({
    "/remote/a.js": "// @preload b.js",
    "/remote/b.js": "// @preload a.js",
  });
  await expect(load({ file: "a.js" })).rejects.toThrow("/remote/a.js");
  for (const code of [
    "// @preload",
    "// @preload bad.ts",
    "// @preload missing.js",
    "// @preload a.js",
  ]) {
    await expect(load({ code })).rejects.toThrow();
  }
});

it("bounds file count, source bytes, and recursion independently", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [`/remote/${i}.js`, "// library"]),
  );
  const { load } = loader(files);
  await expect(
    load({ code: Array.from({ length: 65 }, (_, i) => `// @preload ${i}.js`).join("\n") }),
  ).rejects.toThrow();
  files["/remote/0.js"] = " ".repeat(1024 * 1024 + 1);
  await expect(load({ file: "0.js" })).rejects.toThrow();
  for (let i = 0; i < 9; i++) files[`/remote/${i}.js`] = " ".repeat(1024 * 1024);
  await expect(
    load({ code: Array.from({ length: 9 }, (_, i) => `// @preload ${i}.js`).join("\n") }),
  ).rejects.toThrow();
  for (let i = 0; i < 18; i++) files[`/remote/${i}.js`] = `// @preload ${i + 1}.js`;
  await expect(load({ file: "0.js" })).rejects.toThrow();
});

it("stops reading dependencies when cancellation arrives during a backend read", async () => {
  const controller = new AbortController();
  const { load, readFileBinary } = loader(
    { "/remote/main.js": "// @preload next.js" },
    controller.signal,
  );
  readFileBinary.mockImplementationOnce(async () => {
    controller.abort();
    return { content: Buffer.from("// @preload next.js") };
  });
  await expect(load({ file: "main.js" })).rejects.toThrow();
  expect(readFileBinary).toHaveBeenCalledTimes(1);
});
