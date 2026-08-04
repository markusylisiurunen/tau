import { describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "../dist/core/tools/catalog.js";

function createBackend() {
  return {
    runNodeScript: vi.fn(async (_script, args) => {
      const requests = JSON.parse(args[0]);
      const stdout = JSON.stringify(requests.map(() => null));
      return {
        output: stdout,
        stdout,
        stderr: "",
        exitCode: 0,
        truncated: false,
      };
    }),
    readFile: vi.fn(async (path) => ({ path, content: "old text" })),
    readFileBinary: vi.fn(async (path) => ({ path, content: Buffer.from("not an image") })),
    writeFile: vi.fn(async (path, content) => ({ path, bytes: Buffer.byteLength(content) })),
  };
}

function executionContext() {
  return {
    agentId: "child-agent",
    turnId: "child-turn",
    assistantMessageId: "child-assistant",
    signal: new AbortController().signal,
    emitActivity: async () => {},
  };
}

async function execute(registry, name, args) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`missing tool '${name}'`);
  return await tool.execute(
    { type: "toolCall", id: `${name}-call`, name, arguments: args },
    executionContext(),
  );
}

describe("ToolCatalog", () => {
  it("binds history for subagents without exposing its storage or credentials", () => {
    const history = {
      search: vi.fn(),
      read: vi.fn(),
    };
    const registry = ToolCatalog.createSubagentRegistry(
      ["history"],
      createBackend(),
      "/workspace/child",
      {},
      history,
    );

    expect(registry.schemas.map((tool) => tool.name)).toEqual(["history"]);
  });

  it("scopes every child filesystem and process tool to the child working directory", async () => {
    const backend = createBackend();
    const registry = ToolCatalog.createSubagentRegistry(
      ["write", "edit", "view_image", "web"],
      backend,
      "/workspace/child",
      {},
    );

    await execute(registry, "write", { path: "created.txt", content: "created" });
    await execute(registry, "edit", {
      path: "edited.txt",
      oldText: "old",
      newText: "new",
    });
    await execute(registry, "view_image", { path: "image.png" });
    await execute(registry, "web", {
      code: "console.log(JSON.stringify(await web.discover('https://example.com/docs')))",
    });

    expect(backend.writeFile).toHaveBeenCalledWith("/workspace/child/created.txt", "created");
    expect(backend.readFile).toHaveBeenCalledWith("/workspace/child/edited.txt");
    expect(backend.writeFile).toHaveBeenCalledWith("/workspace/child/edited.txt", "new text");
    expect(backend.readFileBinary).toHaveBeenCalledWith(
      "/workspace/child/image.png",
      expect.any(Object),
    );
    expect(backend.runNodeScript).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: "/workspace/child" }),
    );
  });
});
