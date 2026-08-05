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

async function runTool(tool, toolCall, signal = new AbortController().signal) {
  const activities = [];
  const outcome = await tool.execute(toolCall, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    toolResult: { ...outcome, toolCallId: toolCall.id, toolName: toolCall.name },
    uiEvent: activities.at(-1),
    activities,
  };
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

  it("enforces single-line paths in the tool contract", async () => {
    const editTool = createEditToolDefinition(createLocalToolExecutionBackend());

    expect(editTool.schema.parameters.properties.path.pattern).toBe("^[^\\r\\n]+$");

    const result = await runTool(editTool, {
      id: "tool-invalid-path",
      name: TOOL_NAME_EDIT,
      arguments: {
        path: "one\ntwo",
        oldText: "one",
        newText: "two",
      },
    });

    expect(result.toolResult.outcome).toBe("blocked");
    expect(result.uiEvent.presentation.details[0].text).toContain("single line");
  });

  it("renders the complete dim line diff with net metadata", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "large-edit.txt");
      const oldText = Array.from({ length: 20 }, (_, index) => `old ${index + 1}`).join("\n");
      const newText = Array.from({ length: 22 }, (_, index) => `new ${index + 1}`).join("\n");
      writeFileSync(filePath, oldText);

      const editTool = createEditToolDefinition(createLocalToolExecutionBackend());
      const result = await runTool(editTool, {
        id: "tool-full-diff",
        name: TOOL_NAME_EDIT,
        arguments: { path: filePath, oldText, newText },
      });

      expect(result.toolResult.outcome).toBe("succeeded");
      expect(result.uiEvent.presentation.details).toHaveLength(42);
      expect(
        result.uiEvent.presentation.details.slice(0, 20).every((line) => line.tone === "removed"),
      ).toBe(true);
      expect(
        result.uiEvent.presentation.details.slice(20).every((line) => line.tone === "added"),
      ).toBe(true);
      expect(result.uiEvent.presentation.metadata).toEqual([
        "+2 lines",
        `+${newText.length - oldText.length} chars`,
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
