import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../dist/core/tools/edit.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { TOOL_NAME_EDIT } from "../dist/core/tools/tool_names.js";

function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tau-edit-tool-"));
  return {
    dir: resolve(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function runTool(tool, ...args) {
  const dispatch = await tool.dispatch(...args);
  return dispatch.run;
}

describe("edit tool", () => {
  it("resolves backend file operations relative to the configured cwd", async () => {
    const fx = setupFixture();

    try {
      writeFileSync(join(fx.dir, "input.txt"), "hello\n", "utf-8");

      const backend = createLocalToolExecutionBackend({
        env: {
          cwd: () => fx.dir,
        },
      });

      const read = await backend.readFile("input.txt");
      expect(read.path).toBe(join(fx.dir, "input.txt"));
      expect(read.content).toBe("hello\n");

      const written = await backend.writeFile("output.txt", "world\n");
      expect(written.path).toBe(join(fx.dir, "output.txt"));
      expect(readFileSync(join(fx.dir, "output.txt"), "utf-8")).toBe("world\n");

      const binary = Buffer.from([0, 255, 1]);
      const binaryWritten = await backend.writeFileBinary("assets/output.bin", binary);
      expect(binaryWritten).toEqual({ path: join(fx.dir, "assets", "output.bin"), bytes: 3 });
      expect(readFileSync(join(fx.dir, "assets", "output.bin"))).toEqual(binary);

      const listed = await backend.listDir(".");
      expect(listed.path).toBe(fx.dir);
      expect(listed.entries.map((entry) => entry.name).sort()).toEqual([
        "assets",
        "input.txt",
        "output.txt",
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("treats $ sequences as literal replacements", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "example.ts");
      const originalLines = [
        `const cost = \`\${formatAdaptiveNumber(entry.costTotal, 2, 5)}\`;`,
        'const label = "price";',
      ];
      writeFileSync(filePath, `${originalLines.join("\n")}\n`);

      const backend = createLocalToolExecutionBackend();
      const editTool = createEditToolDefinition(backend);

      await runTool(editTool, {
        id: "tool-1",
        name: TOOL_NAME_EDIT,
        arguments: {
          path: filePath,
          oldText: originalLines[0],
          newText: "const cost = `$${formatAdaptiveNumber(entry.costTotal, 2, 5)}`;",
        },
      });

      await runTool(editTool, {
        id: "tool-2",
        name: TOOL_NAME_EDIT,
        arguments: {
          path: filePath,
          oldText: originalLines[1],
          newText: 'const label = "$1";',
        },
      });

      const updated = readFileSync(filePath, "utf-8");
      expect(updated).toBe(
        [
          "const cost = `$${formatAdaptiveNumber(entry.costTotal, 2, 5)}`;",
          'const label = "$1";',
          "",
        ].join("\n"),
      );
    } finally {
      fx.cleanup();
    }
  });
});
