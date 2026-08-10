import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCommandClientTools } from "../dist/core/client_tools/command_client_tools.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import {
  TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES,
  TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAMES,
} from "../dist/sdk/client_tool_command.js";
import { createProtocolExecResult } from "./helpers/session_protocol_fixtures.js";

const commandModuleUrl = pathToFileURL(resolve("dist/sdk/index.js")).href;
const codeModeModuleUrl = pathToFileURL(resolve("dist/code_mode/index.js")).href;

function resultFrame(content = "done") {
  return `${JSON.stringify({ version: 3, type: "result", content })}\n`;
}

function createSpawnResult(overrides = {}) {
  return {
    stdout: resultFrame(),
    stderr: "",
    exitCode: 0,
    captureLimitExceeded: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
    ...overrides,
  };
}

function createDeps(spawn) {
  return { spawn };
}

function createConfig(overrides = {}) {
  return {
    name: "notify",
    defaultEnabled: true,
    description: "Show a local notification.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    command: "/home/user/tools/notify",
    args: ["--json"],
    executionTimeoutMs: 5000,
    ...overrides,
  };
}

function createContext(overrides = {}) {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    callId: "call-1",
    signal: new AbortController().signal,
    executionEnvironment: {
      exec: vi.fn(async () => createProtocolExecResult({ output: "workspace output" })),
    },
    ...overrides,
  };
}

describe("command client tools", () => {
  it("exposes the execution environment through the command helper", async () => {
    const script = [
      `import { runTauClientToolCommand } from ${JSON.stringify(commandModuleUrl)};`,
      "await runTauClientToolCommand(async (args, context) => {",
      '  const result = await context.executionEnvironment.exec("printf workspace", {',
      '    args: ["first"],',
      '    stdin: Buffer.from("input"),',
      "  });",
      '  return { content: args.message + "\\n" + result.output };',
      "});",
    ].join("\n");
    const [tool] = createCommandClientTools([
      createConfig({
        command: process.execPath,
        args: ["--input-type=module", "--eval", script],
      }),
    ]);
    const context = createContext();

    await expect(tool.execute({ message: "hello" }, context)).resolves.toEqual({
      content: "hello\nworkspace output",
    });
    expect(context.executionEnvironment.exec).toHaveBeenCalledWith("printf workspace", {
      args: ["first"],
      stdin: Buffer.from("input"),
      signal: expect.any(AbortSignal),
    });
  });

  it("carries large scratch-file operations outside the stderr capture budget", async () => {
    const script = [
      `import { runTauCodeModeCommand } from ${JSON.stringify(codeModeModuleUrl)};`,
      "await runTauCodeModeCommand({",
      '  name: "linear",',
      '  documentation: "# Linear API",',
      "  api: { echo: async ([value]) => value },",
      "});",
    ].join("\n");
    const [tool] = createCommandClientTools([
      createConfig({
        name: "linear",
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
        command: process.execPath,
        args: ["--input-type=module", "--eval", script],
        executionTimeoutMs: 15_000,
      }),
    ]);
    const backend = createLocalToolExecutionBackend();
    const executionEnvironment = {
      exec: (command, options) => backend.runBash(command, options),
    };
    const agentId = `test-${randomUUID()}`;
    const scope = createHash("sha256").update(agentId).digest("hex").slice(0, 32);
    const root = join(tmpdir(), `tau-code-mode-files-${scope}`);

    try {
      const result = await tool.execute(
        {
          code: [
            'const first = await files.write("first.txt", "x".repeat(900 * 1024));',
            'const second = await files.write("second.txt", "y".repeat(900 * 1024));',
            'const content = await files.read("first.txt");',
            "console.log({ first, second, length: content.length });",
          ].join("\n"),
        },
        createContext({ agentId, executionEnvironment }),
      );
      const output = JSON.parse(result.content);

      expect(dirname(output.first.path)).toBe(root);
      expect(output).toMatchObject({
        first: { bytes: 900 * 1024 },
        second: { bytes: 900 * 1024 },
        length: 900 * 1024,
      });
      expect(output.first.path).not.toBe(output.second.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}-staging`, { recursive: true, force: true });
      await backend.dispose();
    }
  });

  it("inherits the TUI process cwd and environment unchanged", async () => {
    const variableName = `TAU_COMMAND_CLIENT_TOOL_TEST_${process.pid}`;
    const previousValue = process.env[variableName];
    process.env[variableName] = "inherited";

    try {
      const script = [
        `import { runTauClientToolCommand } from ${JSON.stringify(commandModuleUrl)};`,
        "await runTauClientToolCommand(() => ({",
        `  content: process.cwd() + "\\n" + process.env[${JSON.stringify(variableName)}],`,
        "}));",
      ].join("\n");
      const [tool] = createCommandClientTools([
        createConfig({
          command: process.execPath,
          args: ["--input-type=module", "--eval", script],
        }),
      ]);

      await expect(tool.execute({ message: "hello" }, createContext())).resolves.toEqual({
        content: `${process.cwd()}\ninherited`,
      });
    } finally {
      if (previousValue === undefined) {
        delete process.env[variableName];
      } else {
        process.env[variableName] = previousValue;
      }
    }
  });

  it("starts a configured command with the versioned invocation", async () => {
    const spawn = vi.fn(async () => createSpawnResult({ stderr: "diagnostic\n" }));
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));
    const context = createContext();

    await expect(tool.execute({ message: "hello" }, context)).resolves.toEqual({
      content: "done",
    });
    expect(tool.schema).toEqual({
      name: "notify",
      description: "Show a local notification.",
      parameters: createConfig().parameters,
      executionTimeoutMs: 5000,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/home/user/tools/notify",
      ["--json"],
      expect.objectContaining({
        detached: true,
        signal: expect.any(AbortSignal),
        timeoutMs: 5000,
        maxCaptureBytes: 1024 * 1024,
        maxCaptureMode: "terminate",
        captureOutput: "stderr",
        killProcessGroup: true,
        stdio: ["pipe", "pipe", "pipe"],
        keepStdinOpen: true,
        input: `${JSON.stringify({
          version: 3,
          type: "invoke",
          sessionId: "session-1",
          agentId: "agent-1",
          callId: "call-1",
          arguments: { message: "hello" },
        })}\n`,
        onSpawn: expect.any(Function),
      }),
    );
    expect(spawn.mock.calls[0][2]).not.toHaveProperty("cwd");
    expect(spawn.mock.calls[0][2]).not.toHaveProperty("env");
  });

  it("validates arguments before starting the command", async () => {
    const spawn = vi.fn(async () => createSpawnResult());
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

    await expect(tool.execute({ message: 42 }, createContext())).rejects.toThrow(
      "Invalid arguments for command client tool 'notify': /message must be string.",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports command failures using stderr", async () => {
    const spawn = vi.fn(async () =>
      createSpawnResult({
        stdout: "",
        stderr: "notifications unavailable\n",
        exitCode: 2,
      }),
    );
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

    await expect(tool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      "Command client tool 'notify' failed with exit code 2: notifications unavailable",
    );
  });

  it("requires a version-3 result frame", async () => {
    const spawn = vi.fn(async () => createSpawnResult({ stdout: "" }));
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

    await expect(tool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      "returned no version-3 result frame",
    );
  });

  it("bounds incomplete protocol frames independently of stderr capture", async () => {
    const spawn = vi.fn(async () =>
      createSpawnResult({
        stdout: "x".repeat(TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES + 1),
      }),
    );
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

    await expect(tool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      `exceeded the ${TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAME_BYTES}-byte protocol frame limit`,
    );
  });

  it("bounds total protocol frames", async () => {
    const stdout = Array.from(
      { length: TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAMES + 1 },
      (_, index) =>
        JSON.stringify({
          version: 3,
          type: "exec.cancel",
          requestId: String(index),
        }),
    ).join("\n");
    const spawn = vi.fn(async () => createSpawnResult({ stdout }));
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

    await expect(tool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      `exceeded the ${TAU_CLIENT_TOOL_COMMAND_MAX_PROTOCOL_FRAMES}-frame protocol limit`,
    );
  });

  it("limits execution requests to eight active operations", async () => {
    const script = [
      `import { runTauClientToolCommand } from ${JSON.stringify(commandModuleUrl)};`,
      "await runTauClientToolCommand(async (_args, context) => {",
      "  await Promise.all(Array.from({ length: 9 }, (_, index) =>",
      '    context.executionEnvironment.exec("sleep", { args: [String(index)] }),',
      "  ));",
      '  return "done";',
      "});",
    ].join("\n");
    const [tool] = createCommandClientTools([
      createConfig({
        command: process.execPath,
        args: ["--input-type=module", "--eval", script],
      }),
    ]);
    const executionEnvironment = {
      exec: vi.fn(
        (_command, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    };

    await expect(
      tool.execute({ message: "hello" }, createContext({ executionEnvironment })),
    ).rejects.toThrow("exceeded the 8-execution concurrency limit");
    expect(executionEnvironment.exec).toHaveBeenCalledTimes(8);
  });

  it("rejects invalid protocol output", async () => {
    const invalidJsonSpawn = vi.fn(async () => createSpawnResult({ stdout: "done\n" }));
    const invalidShapeSpawn = vi.fn(async () =>
      createSpawnResult({
        stdout: `${JSON.stringify({ version: 3, type: "result", content: "done", extra: true })}\n`,
      }),
    );
    const oversizedResultSpawn = vi.fn(async () =>
      createSpawnResult({ stdout: resultFrame("x".repeat(1024 * 1024 + 1)) }),
    );

    const [invalidJsonTool] = createCommandClientTools(
      [createConfig()],
      createDeps(invalidJsonSpawn),
    );
    const [invalidShapeTool] = createCommandClientTools(
      [createConfig()],
      createDeps(invalidShapeSpawn),
    );
    const [oversizedResultTool] = createCommandClientTools(
      [createConfig()],
      createDeps(oversizedResultSpawn),
    );

    await expect(invalidJsonTool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      "invalid JSON protocol framing",
    );
    await expect(invalidShapeTool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      "invalid version-3 protocol frame",
    );
    await expect(
      oversizedResultTool.execute({ message: "hello" }, createContext()),
    ).rejects.toThrow("invalid version-3 protocol frame");
  });

  it("reports timeout and stderr-limit termination", async () => {
    const timeoutSpawn = vi.fn(async () => createSpawnResult({ timedOut: true, exitCode: null }));
    const limitSpawn = vi.fn(async () =>
      createSpawnResult({ captureLimitExceeded: true, exitCode: null }),
    );
    const [timeoutTool] = createCommandClientTools([createConfig()], createDeps(timeoutSpawn));
    const [limitTool] = createCommandClientTools([createConfig()], createDeps(limitSpawn));

    await expect(timeoutTool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      "timed out after 5000ms",
    );
    await expect(limitTool.execute({ message: "hello" }, createContext())).rejects.toThrow(
      "exceeded the 1048576-byte stderr limit",
    );
  });
});
