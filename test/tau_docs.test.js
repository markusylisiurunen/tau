import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { createTauDocsToolDefinition, TAU_DOCS_TOOL } from "../dist/core/tools/tau_docs.js";
import { TOOL_NAME_TAU_DOCS } from "../dist/core/tools/tool_names.js";

const context = {
  agentId: "test-agent",
  turnId: "test-turn",
  assistantMessageId: "test-assistant",
  signal: new AbortController().signal,
  emitActivity: async () => {},
};

async function execute(tool, path) {
  return await tool.execute(
    {
      type: "toolCall",
      id: "tau-docs-call",
      name: TOOL_NAME_TAU_DOCS,
      arguments: { path },
    },
    context,
  );
}

function resultText(result) {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("tau_docs tool", () => {
  it("describes index-first version-matched documentation access", () => {
    expect(TAU_DOCS_TOOL.description).toContain("version-matched");
    expect(TAU_DOCS_TOOL.description).toContain("Begin with index.md");
    expect(TAU_DOCS_TOOL.parameters.additionalProperties).toBe(false);
  });

  it("reads a packaged document", async () => {
    const result = await execute(createTauDocsToolDefinition(), "index.md");

    expect(result.outcome).toBe("succeeded");
    expect(resultText(result)).toContain("# Tau documentation");
  });

  it("rejects unknown and nested paths", async () => {
    const tool = createTauDocsToolDefinition();
    const unknown = await execute(tool, "missing.md");
    const nested = await execute(tool, "configuration/personas.md");

    expect(unknown.outcome).toBe("blocked");
    expect(resultText(unknown)).toContain("Read index.md");
    expect(nested.outcome).toBe("blocked");
    expect(resultText(nested)).toContain("flat lowercase-dash .md path");
  });

  it("is intrinsic to main-agent and subagent registries", () => {
    const mainRegistry = ToolCatalog.createDebugRegistry({
      backend: {},
      cwd: "/workspace",
      config: {},
      persona: { tools: [] },
      modelResolver: () => undefined,
      history: {},
    });
    const subagentRegistry = ToolCatalog.createSubagentRegistry([], {}, "/workspace", {});

    expect(mainRegistry.schemas.map((tool) => tool.name)).toContain(TOOL_NAME_TAU_DOCS);
    expect(subagentRegistry.schemas.map((tool) => tool.name)).toEqual([TOOL_NAME_TAU_DOCS]);
  });
});
