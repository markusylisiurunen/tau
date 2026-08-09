import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildTauCodeModeToolDescription,
  executeTauCodeMode,
  runTauCodeModeCommand,
} from "../dist/code_mode/index.js";
import { createTauCodeModeClientTool } from "../dist/sdk/index.js";

const invocation = {
  sessionId: "session-1",
  callId: "call-1",
};

function createDefinition(overrides = {}) {
  return {
    name: "linear",
    documentation: "# Linear API\n\nUse `linear.issues.get(id)` to read an issue.",
    api: {
      issues: {
        get: async ([id], context) => ({ id, invocation: context.invocation }),
      },
    },
    ...overrides,
  };
}

describe("public code-mode runtime", () => {
  it("executes a nested API through the JSON bridge", async () => {
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: 'console.log(await linear.issues.get("TAU-418"))',
      invocation,
    });

    expect(JSON.parse(result.content)).toEqual({
      id: "TAU-418",
      invocation,
    });
  });

  it("prepends canonical runtime documentation", async () => {
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: "console.log(docs)",
    });

    expect(result.content).toContain("# Code-mode runtime");
    expect(result.content).toContain("at most 128 API calls");
    expect(result.content).toContain("at most 8 unresolved calls concurrently");
    expect(result.content).toContain("# Linear API");
  });

  it("rejects non-JSON handler results", async () => {
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { invalid: async () => undefined } }),
        code: "console.log(await linear.invalid())",
      }),
    ).rejects.toThrow("linear.invalid returned a non-JSON value");
  });

  it("offers every terminal output to optional persistence", async () => {
    const persistOutput = vi.fn(async (output, context) => {
      expect(context.invocation).toEqual(invocation);
      return output.contextTruncated ? { path: "/tmp/linear-output" } : undefined;
    });
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: 'console.log("x".repeat(60_000))',
      invocation,
      persistOutput,
    });

    expect(persistOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        captureTruncated: false,
        contextTruncated: true,
        status: "succeeded",
      }),
      expect.objectContaining({ invocation }),
    );
    expect(result.content).toContain("Output truncated for context");
    expect(result.content).toContain("saved to /tmp/linear-output");
  });

  it("offers failed output to optional persistence", async () => {
    const persistOutput = vi.fn(async () => undefined);

    await expect(
      executeTauCodeMode({
        ...createDefinition({
          api: {
            fail: async () => {
              throw new Error("integration unavailable");
            },
          },
        }),
        code: "await linear.fail()",
        persistOutput,
      }),
    ).rejects.toThrow("integration unavailable");
    expect(persistOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
      expect.any(Object),
    );
  });

  it("passes SDK descriptions through unchanged", async () => {
    const description = "Use the Linear integration exactly as documented here.";
    const tool = createTauCodeModeClientTool({
      ...createDefinition(),
      description,
    });

    expect(tool.schema).toMatchObject({
      name: "linear",
      description,
      parameters: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
      },
    });
    await expect(
      tool.execute(
        { code: 'console.log(await linear.issues.get("TAU-418"))' },
        { ...invocation, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ id: "TAU-418", invocation }),
    });
  });

  it("builds the progressive-disclosure description only when requested", () => {
    expect(
      buildTauCodeModeToolDescription({
        name: "linear",
        description: "Search Linear issues.",
      }),
    ).toBe(
      "Search Linear issues. When this tool is useful, your first call must be a documentation-only program that does nothing except print docs with console.log(docs). Read the returned documentation before writing a later tool call that uses linear. Do not guess API signatures.",
    );
  });
});

describe("code-mode command adapter", () => {
  it("reads and writes the command client-tool framing", () => {
    expect(typeof runTauCodeModeCommand).toBe("function");
    const moduleUrl = pathToFileURL(resolve("dist/code_mode/index.js")).href;
    const script = [
      `import(${JSON.stringify(moduleUrl)}).then(async ({ runTauCodeModeCommand }) => {`,
      "  await runTauCodeModeCommand({",
      '    name: "linear",',
      '    documentation: "# Linear API",',
      "    api: { echo: async ([value], context) => ({ value, invocation: context.invocation }) },",
      "  });",
      "});",
    ].join("\n");
    const request = {
      version: 1,
      sessionId: invocation.sessionId,
      callId: invocation.callId,
      arguments: {
        code: 'console.log(await linear.echo("hello"))',
      },
    };
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(request),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      content: JSON.stringify({ value: "hello", invocation }),
    });
  });
});
