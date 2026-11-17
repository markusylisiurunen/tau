import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTauDocsToolDefinition } from "../dist/core/tools/tau_docs.js";
import { TOOL_NAME_TAU_DOCS } from "../dist/core/tools/tool_names.js";

async function execute(path) {
  return await createTauDocsToolDefinition().execute(
    {
      type: "toolCall",
      id: "tau-docs-call",
      name: TOOL_NAME_TAU_DOCS,
      arguments: { path },
    },
    {
      agentId: "test-agent",
      turnId: "test-turn",
      assistantMessageId: "test-assistant",
      signal: new AbortController().signal,
      emitActivity: async () => {},
    },
  );
}

describe("tau_docs tool", () => {
  it("reads the packaged manual", async () => {
    const result = await execute("index.md");
    expect(result.outcome).toBe("succeeded");
    expect(result.content).toEqual([
      {
        type: "text",
        text: await readFile(
          new URL("../dist/core/static/tau_docs/index.md", import.meta.url),
          "utf8",
        ),
      },
    ]);
  });

  it("blocks paths outside the flat manual", async () => {
    const result = await execute("../../package.json");
    expect(result.outcome).toBe("blocked");
  });
});
