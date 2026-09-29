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
  const activities = [];
  const result = await tool.execute(
    {
      type: "toolCall",
      id: "tau-docs-call",
      name: TOOL_NAME_TAU_DOCS,
      arguments: { path },
    },
    {
      ...context,
      emitActivity: async (activity) => activities.push(activity),
    },
  );
  return { ...result, uiEvent: activities.at(-1) };
}

function resultText(result) {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("tau_docs tool", () => {
  it("describes scoped index-first documentation access", () => {
    expect(TAU_DOCS_TOOL.description).toContain("running Tau version");
    expect(TAU_DOCS_TOOL.description).toContain("Do not call it merely because Tau is mentioned");
    expect(TAU_DOCS_TOOL.description).toContain(
      "In a Tau source checkout, inspect source and tests instead",
    );
    expect(TAU_DOCS_TOOL.description).toContain("Begin with index.md for general documentation");
    expect(TAU_DOCS_TOOL.description).toContain("Their use is optional");
    expect(TAU_DOCS_TOOL.description).toContain("read its listed page directly through tau_docs");
    expect(TAU_DOCS_TOOL.description).toContain(
      "does not guarantee its executable, dependencies, or credentials are available there",
    );
    expect(TAU_DOCS_TOOL.parameters.additionalProperties).toBe(false);
  });

  it("reads a packaged document", async () => {
    const result = await execute(createTauDocsToolDefinition(), "index.md");

    expect(result.outcome).toBe("succeeded");
    const content = resultText(result);
    const lines = content.trimEnd().split("\n");
    expect(content).toContain("# Tau documentation");
    expect(result.uiEvent.presentation.subject).toBe("index.md");
    expect(result.uiEvent.presentation.actionByStatus).toMatchObject({
      preparing: "preparing docs",
      queued: "queued docs read",
      running: "reading docs",
      succeeded: "read docs",
    });
    expect(result.uiEvent.presentation.details.map((line) => line.text)).toEqual([
      ...lines.slice(0, 3),
      `…${lines.length - 6} more lines…`,
      ...lines.slice(-3),
    ]);
    expect(result.uiEvent.presentation.metadata).toEqual([
      `~${Math.floor(Buffer.byteLength(content) / 6)} tokens`,
      `${lines.length} lines`,
    ]);
  });

  it.each([
    ["pdf-unpack", "pdf-unpacking.md"],
    ["image-generate", "image-generation.md"],
    ["speech-generate", "speech-generation.md"],
  ])("exposes the dedicated %s guide through the description and index", async (command, path) => {
    expect(TAU_DOCS_TOOL.description).toContain(`Documentation: ${path}.`);
    const tool = createTauDocsToolDefinition();
    const index = await execute(tool, "index.md");
    expect(resultText(index)).toContain(`](${path})`);
    const result = await execute(tool, path);
    expect(result.outcome).toBe("succeeded");
    expect(resultText(result)).toContain(`tau tool ${command}`);
    for (const heading of [
      "Credentials and requirements",
      "Input and examples",
      "Outputs and recovery",
    ]) {
      expect(resultText(result)).toContain(`## ${heading}`);
    }
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
