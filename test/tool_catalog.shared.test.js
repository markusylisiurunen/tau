import { describe, expect, it, vi } from "vitest";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { CodeJobRegistry } from "../dist/core/tools/code_jobs.js";

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
  it("shares enabled capabilities while excluding agent management from child runtimes", () => {
    const tools = ["bash", "write", "edit", "view_image", "web", "history", "models", "agents"];
    const options = {
      backend: createBackend(),
      cwd: "/workspace",
      config: {},
      persona: { tools },
      modelResolver: () => undefined,
      history: {},
    };
    const main = ToolCatalog.createDebugRegistry(options);
    const child = ToolCatalog.createSubagentRegistry(
      tools,
      options.backend,
      options.cwd,
      options.config,
      new BashJobRegistry(),
      new CodeJobRegistry(),
      options.history,
    );
    const management = [
      "spawn_agent",
      "list_agents",
      "wait_for_agents",
      "send_input_to_agent",
      "interrupt_agent",
      "list_notifications",
      "read_notification",
    ];
    expect(child.schemas.map((tool) => tool.name)).toEqual(
      main.schemas.filter((tool) => !management.includes(tool.name)).map((tool) => tool.name),
    );
    expect(main.get("code").schema.description).toContain("tau.agents");
    expect(child.get("code").schema.description).not.toContain("tau.agents");
    for (const name of management) expect(child.get(name)).toBeUndefined();
  });

  it("keeps intrinsic tools available when the persona selects no capabilities", () => {
    const backend = createBackend();
    const main = ToolCatalog.createDebugRegistry({
      backend,
      cwd: "/workspace",
      config: {},
      persona: { tools: [] },
      modelResolver: () => undefined,
    });
    const child = ToolCatalog.createSubagentRegistry(
      [],
      backend,
      "/workspace/child",
      {},
      new BashJobRegistry(),
      new CodeJobRegistry(),
    );
    const intrinsicTools = ["tau_docs"];
    expect(main.schemas.map((tool) => tool.name)).toEqual([
      ...intrinsicTools,
      "list_notifications",
      "read_notification",
    ]);
    expect(child.schemas.map((tool) => tool.name)).toEqual(intrinsicTools);
  });

  it("isolates Bash jobs across child registries without losing their working directory", async () => {
    const jobs = new BashJobRegistry();
    const otherJobs = new BashJobRegistry();
    const backend = createBackend();
    backend.runBash = vi.fn(
      (_command, options) =>
        new Promise((resolve) => {
          options.onStarted();
          options.onOutput(Buffer.from(options.cwd));
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                output: options.cwd,
                exitCode: null,
                aborted: true,
                timedOut: false,
                closeSignal: "SIGTERM",
                truncated: false,
              }),
            { once: true },
          );
        }),
    );
    const first = ToolCatalog.createSubagentRegistry(
      ["bash"],
      backend,
      "/workspace/first",
      {},
      jobs,
      new CodeJobRegistry(),
    );
    const second = ToolCatalog.createSubagentRegistry(
      ["bash"],
      backend,
      "/workspace/second",
      {},
      otherJobs,
      new CodeJobRegistry(),
    );
    try {
      const started = await execute(first, "bash", { command: "server", background: true });
      const id = started.content[0].text.match(/job ([^ ]+)/)[1];
      const listed = await execute(second, "list_bash_jobs", {});
      expect(listed.content[0].text).not.toContain(id);
      expect((await execute(second, "read_bash_job", { id })).outcome).toBe("failed");
      expect((await execute(second, "stop_bash_job", { id })).outcome).toBe("failed");
      expect(backend.runBash).toHaveBeenCalledWith(
        "server",
        expect.objectContaining({ cwd: "/workspace/first" }),
      );
      expect(backend.runBash.mock.calls[0][1].timeoutMs).toBeUndefined();
      expect((await execute(first, "stop_bash_job", { id })).content[0].text).toContain("stopped");
    } finally {
      await jobs.dispose();
    }
  });

  it("scopes every child filesystem and process tool to the child working directory", async () => {
    const backend = createBackend();
    const registry = ToolCatalog.createSubagentRegistry(
      ["write", "edit", "view_image", "web"],
      backend,
      "/workspace/child",
      {},
      new BashJobRegistry(),
      new CodeJobRegistry(),
    );

    await execute(registry, "write", { path: "created.txt", content: "created" });
    await execute(registry, "edit", {
      path: "edited.txt",
      oldText: "old",
      newText: "new",
    });
    await execute(registry, "view_image", { path: "image.png" });
    await execute(registry, "code", {
      code: "printText(JSON.stringify(await tau.web.discover('https://example.com/docs')))",
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
