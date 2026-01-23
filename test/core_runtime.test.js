import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { formatHistoryForCompaction } from "../dist/core/utils/compact.js";
import {
  buildEnvironmentTag,
  buildProjectContextBlock,
} from "../dist/core/utils/context_builder.js";

describe("command registry", () => {
  it("parses and dispatches commands", async () => {
    const registry = createCommandRegistry();
    const calls = [];

    const ctx = {
      help: () => calls.push({ type: "help" }),
      copy: async () => calls.push({ type: "copy" }),
      copyCode: async () => calls.push({ type: "copyCode" }),
      export: async () => calls.push({ type: "export" }),
      newSession: () => calls.push({ type: "new" }),
      compactOnlySummary: async () => calls.push({ type: "compactOnlySummary" }),
      compactSummaryAndLastTurn: async () => calls.push({ type: "compactSummaryAndLastTurn" }),
      reload: async () => calls.push({ type: "reload" }),
      risk: (level) => calls.push({ type: "risk", level }),
      persona: (id) => calls.push({ type: "persona", id }),
      prompt: (id) => calls.push({ type: "prompt", id }),
      bash: async (id) => calls.push({ type: "bash", id }),
      unknown: (raw) => calls.push({ type: "unknown", raw }),
    };

    const cmd = registry.parse("/risk:read-only");
    expect(cmd).toEqual({ type: "risk", level: "read-only" });
    await registry.dispatch(cmd, ctx);

    const unknown = registry.parse("/not-a-command");
    await registry.dispatch(unknown, ctx);

    expect(calls).toContainEqual({ type: "risk", level: "read-only" });
    expect(calls).toContainEqual({ type: "unknown", raw: "/not-a-command" });
  });
});

describe("tool enablement by risk level", () => {
  it("exposes a stable tool list", () => {
    const backend = createLocalToolExecutionBackend();
    const registry = ToolCatalog.createRegistry(backend);

    const allTools = registry.schemas.map((tool) => tool.name).sort();
    const enabled = registry
      .getEnabledToolSchemas()
      .map((tool) => tool.name)
      .sort();

    expect(allTools).not.toContain("read");
    expect(allTools).not.toContain("grep");
    expect(allTools).not.toContain("list");
    expect(enabled).toEqual(allTools);
  });
});

describe("context builder", () => {
  it("renders environment and project context blocks", () => {
    const tag = buildEnvironmentTag({
      datetime: "2025-01-01T00:00:00.000Z",
      cwd: "/repo",
      riskLevel: "read-only",
      platform: "darwin",
      nodeVersion: "v20.0.0",
    });

    expect(tag).toContain("<platform>darwin</platform>");
    expect(tag).toContain("<node>v20.0.0</node>");

    const readFile = (path) => (path === "/repo/AGENTS.md" ? "# Agents\n" : "");
    const block = buildProjectContextBlock({
      cwd: "/repo",
      home: "/home",
      agentsFiles: ["/repo/AGENTS.md"],
      readFile,
    });

    expect(block).toContain('<file path="/repo/AGENTS.md">');
    expect(block).toContain("# Agents");
  });
});

describe("summary formatting", () => {
  it("omits thinking and shows tool markers", () => {
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          {
            type: "toolCall",
            id: "1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: "read",
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("--- USER ---");
    expect(summary).toContain("hello");
    expect(summary).toContain('[Tool call: read({"path":"README.md"})]');
    expect(summary).toContain("[Tool output: read (truncated)]");
    expect(summary).not.toContain("hmm");
  });
});
