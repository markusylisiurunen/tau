import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../dist/core/tools/edit.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tau-edit-tool-"));
  return {
    dir: resolve(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("edit tool", () => {
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

      await editTool.dispatch(
        {
          id: "tool-1",
          name: "edit",
          arguments: {
            path: filePath,
            oldText: originalLines[0],
            newText: "const cost = `$${formatAdaptiveNumber(entry.costTotal, 2, 5)}`;",
          },
        },
        "read-write",
      );

      await editTool.dispatch(
        {
          id: "tool-2",
          name: "edit",
          arguments: {
            path: filePath,
            oldText: originalLines[1],
            newText: 'const label = "$1";',
          },
        },
        "read-write",
      );

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
