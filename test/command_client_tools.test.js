import { describe, expect, it, vi } from "vitest";
import { createCommandClientTools } from "../dist/tui/command_client_tools.js";

function createSpawnResult(overrides = {}) {
  return {
    stdout: JSON.stringify({ content: "done" }),
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
  return {
    spawn,
    env: {
      cwd: () => "/client/project",
      env: () => ({
        PATH: "/usr/bin",
        DISPLAY: ":0",
        API_TOKEN: "inherited-secret",
      }),
    },
  };
}

function createConfig(overrides = {}) {
  return {
    name: "notify",
    description: "Show a local notification.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    command: "/home/user/tools/notify",
    args: ["--json"],
    env: { NOTIFY_STYLE: "brief", EXPLICIT_TOKEN: "allowed" },
    executionTimeoutMs: 5000,
    ...overrides,
  };
}

const context = {
  sessionId: "session-1",
  callId: "call-1",
  signal: new AbortController().signal,
};

describe("command client tools", () => {
  it("exchanges the documented JSON protocol with a real command", async () => {
    const script = [
      'let input = "";',
      "for await (const chunk of process.stdin) input += chunk;",
      "const request = JSON.parse(input);",
      'process.stdout.write(JSON.stringify({ content: "received " + request.arguments.message }));',
    ].join("\n");
    const [tool] = createCommandClientTools([
      createConfig({
        command: process.execPath,
        args: ["--input-type=module", "--eval", script],
        env: undefined,
      }),
    ]);

    await expect(tool.execute({ message: "hello" }, context)).resolves.toEqual({
      content: "received hello",
    });
  });

  it("executes a configured command with a bounded JSON request and parses its result", async () => {
    const spawn = vi.fn(async () => createSpawnResult({ stderr: "diagnostic\n" }));
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

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
        cwd: "/client/project",
        env: {
          PATH: "/usr/bin",
          DISPLAY: ":0",
          NOTIFY_STYLE: "brief",
          EXPLICIT_TOKEN: "allowed",
        },
        detached: true,
        signal: context.signal,
        timeoutMs: 5000,
        maxCaptureBytes: 1024 * 1024,
        maxCaptureMode: "terminate",
        killProcessGroup: true,
        stdio: ["pipe", "pipe", "pipe"],
        input: `${JSON.stringify({
          version: 1,
          sessionId: "session-1",
          callId: "call-1",
          arguments: { message: "hello" },
        })}\n`,
      }),
    );
  });

  it("validates arguments before starting the command", async () => {
    const spawn = vi.fn(async () => createSpawnResult());
    const [tool] = createCommandClientTools([createConfig()], createDeps(spawn));

    await expect(tool.execute({ message: 42 }, context)).rejects.toThrow(
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

    await expect(tool.execute({ message: "hello" }, context)).rejects.toThrow(
      "Command client tool 'notify' failed with exit code 2: notifications unavailable",
    );
  });

  it("rejects invalid success output", async () => {
    const invalidJsonSpawn = vi.fn(async () => createSpawnResult({ stdout: "done\n" }));
    const invalidShapeSpawn = vi.fn(async () =>
      createSpawnResult({ stdout: JSON.stringify({ content: "done", extra: true }) }),
    );

    const [invalidJsonTool] = createCommandClientTools(
      [createConfig()],
      createDeps(invalidJsonSpawn),
    );
    const [invalidShapeTool] = createCommandClientTools(
      [createConfig()],
      createDeps(invalidShapeSpawn),
    );

    await expect(invalidJsonTool.execute({ message: "hello" }, context)).rejects.toThrow(
      `returned invalid JSON; expected {"content":"..."}`,
    );
    await expect(invalidShapeTool.execute({ message: "hello" }, context)).rejects.toThrow(
      `returned an invalid result; expected exactly {"content":"..."}`,
    );
  });

  it("reports timeout and output-limit termination", async () => {
    const timeoutSpawn = vi.fn(async () => createSpawnResult({ timedOut: true, exitCode: null }));
    const limitSpawn = vi.fn(async () =>
      createSpawnResult({ captureLimitExceeded: true, exitCode: null }),
    );
    const [timeoutTool] = createCommandClientTools([createConfig()], createDeps(timeoutSpawn));
    const [limitTool] = createCommandClientTools([createConfig()], createDeps(limitSpawn));

    await expect(timeoutTool.execute({ message: "hello" }, context)).rejects.toThrow(
      "timed out after 5000ms",
    );
    await expect(limitTool.execute({ message: "hello" }, context)).rejects.toThrow(
      "exceeded the 1048576-byte output limit",
    );
  });
});
