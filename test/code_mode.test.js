import { spawn, spawnSync } from "node:child_process";
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
  agentId: "agent-1",
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
    expect(result.content).toContain("a 1.0 MB limit per request or response");
    expect(result.content).not.toContain("`files`");
    expect(result.content).toContain("# Linear API");
  });

  it("rejects oversized bridge arguments before calling the handler", async () => {
    const echo = vi.fn(async ([value]) => value);

    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { echo } }),
        code: 'await linear.echo("x".repeat(1024 * 1024))',
      }),
    ).rejects.toThrow("bridge payload bytes");
    expect(echo).not.toHaveBeenCalled();
  });

  it("rejects oversized handler results before returning them to the worker", async () => {
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { large: async () => "x".repeat(1024 * 1024) } }),
        code: "await linear.large()",
      }),
    ).rejects.toThrow("result exceeded the 1.0 MB bridge payload limit");
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

  it("settles cancellation when a handler ignores its abort signal", async () => {
    let markHandlerStarted;
    const handlerStarted = new Promise((resolve) => {
      markHandlerStarted = resolve;
    });
    const controller = new AbortController();
    const run = executeTauCodeMode({
      ...createDefinition({
        api: {
          stuck: async () => {
            markHandlerStarted();
            return await new Promise(() => {});
          },
        },
      }),
      code: "await linear.stuck()",
      signal: controller.signal,
    });

    await handlerStarted;
    controller.abort();

    await expect(run).rejects.toThrow("(tau) aborted");
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
    expect(
      await tool.describe(
        { code: 'console.log(await linear.issues.get("TAU-418"))' },
        {
          ...invocation,
          signal: new AbortController().signal,
          executionEnvironment: { exec: vi.fn() },
        },
      ),
    ).toMatchObject({
      operation: "linear",
      subject: 'console.log(await linear.issues.get("TAU-418"))',
      subjectWrap: "character",
    });
    await expect(
      tool.execute(
        { code: 'console.log(await linear.issues.get("TAU-418"))' },
        {
          ...invocation,
          signal: new AbortController().signal,
          executionEnvironment: {
            exec: vi.fn(),
          },
        },
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ id: "TAU-418", invocation }),
    });
  });

  it("provides client-tool execution access to trusted code-mode handlers", async () => {
    const executionEnvironment = {
      exec: vi.fn(async () => ({ output: "clean" })),
    };
    const tool = createTauCodeModeClientTool({
      ...createDefinition({
        api: {
          workspace: {
            status: async (_args, context) =>
              (await context.executionEnvironment.exec("git status --short")).output,
          },
        },
      }),
      description: "Inspect the workspace.",
    });

    await expect(
      tool.execute(
        { code: "console.log(await linear.workspace.status())" },
        {
          ...invocation,
          signal: new AbortController().signal,
          executionEnvironment,
        },
      ),
    ).resolves.toEqual({ content: "clean" });
    expect(executionEnvironment.exec).toHaveBeenCalledWith("git status --short");
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

  it("does not pass parent eval flags to the file-backed worker", () => {
    const moduleUrl = pathToFileURL(resolve("dist/code_mode/index.js")).href;
    const script = [
      `import { executeTauCodeMode } from ${JSON.stringify(moduleUrl)};`,
      "const result = await executeTauCodeMode({",
      '  name: "linear",',
      '  documentation: "# Linear API",',
      "  api: { echo: async ([value]) => value },",
      '  code: "console.log(await linear.echo(42))",',
      "});",
      "process.stdout.write(result.content);",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("42");
  });
});

describe("code-mode command adapter", () => {
  it("reads and writes the command client-tool framing", async () => {
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
      version: 4,
      type: "prepare",
      ...invocation,
      toolName: "linear",
      arguments: {
        code: 'console.log(await linear.echo("hello"))',
      },
    };
    const result = await runCommandWithOpenStdin(script, request);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const frames = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames).toEqual([
      {
        version: 4,
        type: "ready",
        presentation: expect.objectContaining({
          operation: "linear",
          subject: 'console.log(await linear.echo("hello"))',
          subjectWrap: "character",
        }),
      },
      {
        version: 4,
        type: "result",
        content: JSON.stringify({ value: "hello", invocation }),
      },
    ]);
  });

  it("aborts the handler when protocol input closes", () => {
    const moduleUrl = pathToFileURL(resolve("dist/sdk/index.js")).href;
    const script = [
      `import { runTauClientToolCommand } from ${JSON.stringify(moduleUrl)};`,
      "await runTauClientToolCommand({",
      '  name: "wait",',
      '  describe: () => ({ subject: "input" }),',
      "  execute: async (_args, context) => {",
      "    await new Promise((_resolve, reject) => {",
      '      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });',
      "    });",
      '    return "unreachable";',
      "  },",
      "});",
    ].join("\n");
    const request = {
      version: 4,
      type: "prepare",
      ...invocation,
      toolName: "wait",
      arguments: {},
    };
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${JSON.stringify(request)}\n`,
      timeout: 2000,
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("client-tool command input closed during execution");
  });
});

function runCommandWithOpenStdin(script, request) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--eval", script], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let executeSent = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          if (!executeSent && JSON.parse(line).type === "ready") {
            executeSent = true;
            child.stdin.write(`${JSON.stringify({ version: 4, type: "execute" })}\n`);
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectResult);
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
