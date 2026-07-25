import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { personas } from "../dist/core/personas.js";
import {
  createFlySpriteToolExecutionBackend,
  FlySpriteExecutionEnvironment,
  FlySpriteExecutionEnvironmentResolver,
} from "../dist/execution/fly_sprite_execution_environment.js";

class FakeSpriteCommand extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  input = "";

  constructor(handler, options = {}) {
    super();
    this.chunkSize = options.chunkSize;
    this.stdin.on("data", (chunk) => {
      this.input += Buffer.from(chunk).toString("utf-8");
      this.drainInput(handler);
    });
    queueMicrotask(() => {
      this.emit("spawn");
      this.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`, "utf-8"));
    });
  }

  kill() {
    this.killed = true;
    this.emit("exit", 1);
  }

  drainInput(handler) {
    while (true) {
      const newline = this.input.indexOf("\n");
      if (newline === -1) return;

      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      if (!line.trim()) continue;

      const request = JSON.parse(line);
      if (request.method === "shutdown") {
        this.respond(request.id, { exitCode: 0 });
        this.emit("exit", 0);
        continue;
      }
      if (request.method === "cancel") {
        try {
          this.respond(request.id, handler(request) ?? { accepted: false });
        } catch {
          this.respond(request.id, { accepted: false });
        }
        continue;
      }

      try {
        this.respond(request.id, handler(request));
      } catch (err) {
        this.writeMessage({
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  respond(id, result) {
    this.writeMessage({ id, ok: true, result });
  }

  writeMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const chunkSize = this.chunkSize ?? line.length;
    for (let index = 0; index < line.length; index += chunkSize) {
      this.stdout.emit("data", Buffer.from(line.slice(index, index + chunkSize), "utf-8"));
    }
  }
}

class HangingSpriteCommand extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
  }
}

function createFakeSprite(handler, commandOptions = {}) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeSpriteCommand(handler, commandOptions);
    },
  };
}

describe("Fly Sprite execution environment", () => {
  it("runs bash through a persistent SDK-backed worker", async () => {
    const requests = [];
    const sprite = createFakeSprite((request) => {
      requests.push(request);
      expect(request.method).toBe("exec");
      return {
        output: `${request.command}\n`,
        stdout: `${request.command}\n`,
        stderr: "",
        exitCode: 0,
        truncated: false,
      };
    });
    const backend = createFlySpriteToolExecutionBackend({
      sprite,
      cwd: "/home/sprite/repo",
    });

    await expect(backend.runBash("echo hello")).resolves.toEqual({
      output: "echo hello\n",
      stdout: "echo hello\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await expect(backend.runBash("pwd")).resolves.toMatchObject({
      output: "pwd\n",
    });

    expect(sprite.calls).toHaveLength(1);
    expect(sprite.calls[0].command).toBe("node");
    expect(sprite.calls[0].options).toEqual({ cwd: "/home/sprite/repo" });
    expect(requests.map((request) => request.command)).toEqual(["echo hello", "pwd"]);
  });

  it("runs commands through login Bash in the Sprite worker", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-fly-bash-home-"));
    const repo = join(home, "repo");
    await mkdir(repo);
    await writeFile(
      join(home, ".bash_profile"),
      'export TAU_LOGIN_PROFILE=loaded\nprintf "profile output\\n"\n',
      "utf8",
    );
    const sprite = {
      spawn(command, args, options) {
        return spawnChild(command, args, {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    };
    const backend = createFlySpriteToolExecutionBackend({ sprite, cwd: repo });
    const environment = new FlySpriteExecutionEnvironment({
      apiId: "default",
      spriteName: "sprite-1",
      cwd: repo,
      home,
      backend,
    });

    try {
      const result = await environment
        .getToolExecutionBackend()
        .runBash('values=(one two); printf "%s|%s" "$TAU_LOGIN_PROFILE" "$HOME"');

      expect(result.stdout).toBe(`profile output\nloaded|${home}`);
      expect(result.exitCode).toBe(0);
    } finally {
      await environment.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resolves configured APIs through the SDK client factory", async () => {
    const sprite = createFakeSprite(() => ({
      output: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    }));
    const clients = [];
    const resolver = new FlySpriteExecutionEnvironmentResolver({
      apis: {
        default: {
          baseURL: "https://sprites.example",
          tokenEnv: "SPRITES_TOKEN",
        },
      },
      env: { SPRITES_TOKEN: "token-1" },
      createClient(token, options) {
        clients.push({ token, options });
        return {
          sprite(name) {
            clients.push({ spriteName: name });
            return sprite;
          },
        };
      },
    });

    const environment = await resolver.resolve({
      kind: "fly-sprite",
      apiId: "default",
      spriteName: "sprite-1",
      cwd: "/home/sprite/repo",
    });

    expect(clients).toEqual([
      { token: "token-1", options: { baseURL: "https://sprites.example" } },
      { spriteName: "sprite-1" },
    ]);
    expect(environment.snapshot()).toEqual({
      kind: "fly-sprite",
      apiId: "default",
      spriteName: "sprite-1",
      cwd: "/home/sprite/repo",
      home: "/home/sprite",
    });
  });

  it("resolves prompt context and machine metadata through the execution backend", async () => {
    const nodeScriptCalls = [];
    const backend = {
      async runNodeScript(script, args, options) {
        nodeScriptCalls.push({ script, args, options });
        return {
          output: JSON.stringify({
            platform: "linux",
            nodeVersion: "v24.2.0",
            repoRoot: "/home/sprite/repo",
            agentsFiles: [
              { path: "/home/sprite/repo/AGENTS.md", content: "repo instructions" },
              { path: "/home/sprite/AGENTS.md", content: "sprite home instructions" },
            ],
            childAgentsFiles: ["/home/sprite/repo/src/AGENTS.md"],
          }),
          exitCode: 0,
          truncated: false,
        };
      },
      async readFile(path) {
        if (path === "/home/sprite/repo/AGENTS.md") {
          return { path, content: "repo instructions" };
        }
        if (path === "/home/sprite/AGENTS.md") {
          return { path, content: "sprite home instructions" };
        }
        if (path === "/home/sprite/repo/src/AGENTS.md") {
          return { path, content: "nested instructions" };
        }
        throw new Error(`missing ${path}`);
      },
      async readFileBinary() {
        throw new Error("readFileBinary should not be called for prompt context");
      },
      async writeFile() {
        throw new Error("writeFile should not be called for prompt context");
      },
      async listDir(path) {
        throw new Error(`listDir should not be called for prompt context: ${path}`);
      },
    };
    const environment = new FlySpriteExecutionEnvironment({
      apiId: "default",
      spriteName: "sprite-1",
      cwd: "/home/sprite/repo",
      home: "/home/sprite",
      backend,
    });

    const runtimeContext = await environment.resolveRuntimeContext({
      cwd: "/home/sprite/repo",
      persona: personas[0],
      discoveredSkills: [],
      includeAgentContext: true,
      agentContextFiles: [],
    });

    expect(runtimeContext.promptBootstrap.promptContext.cwd).toBe("/home/sprite/repo");
    expect(runtimeContext.promptBootstrap.agentsFiles).toEqual([
      "/home/sprite/repo/AGENTS.md",
      "/home/sprite/AGENTS.md",
    ]);
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "repo instructions",
    );
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "sprite home instructions",
    );
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "/home/sprite/repo/src/AGENTS.md",
    );
    expect(runtimeContext.promptBootstrap.promptContext).toMatchObject({
      repoRoot: "/home/sprite/repo",
      platform: "linux",
      nodeVersion: "v24.2.0",
    });
    expect(nodeScriptCalls).toHaveLength(1);
    expect(nodeScriptCalls[0].args[0]).toBe("/home/sprite/repo");
    expect(nodeScriptCalls[0].options).toMatchObject({
      cwd: "/home/sprite/repo",
      maxCaptureBytes: null,
    });
  });

  it("times out when the worker never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const command = new HangingSpriteCommand();
      const sprite = {
        calls: [],
        spawn(spawnCommand, args, options) {
          this.calls.push({ command: spawnCommand, args, options });
          return command;
        },
      };
      const backend = createFlySpriteToolExecutionBackend({
        sprite,
        cwd: "/home/sprite/repo",
      });

      const read = backend.readFile("/home/sprite/repo/AGENTS.md");
      const readResult = expect(read).rejects.toThrow("timed out waiting for Fly Sprite worker");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(command.killed).toBe(true);

      await readResult;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends cancellation after submitting an already aborted request", async () => {
    const requests = [];
    const sprite = createFakeSprite((request) => {
      requests.push(request);
      if (request.method === "exec") {
        return {
          output: "(tau) aborted\n",
          stdout: "",
          stderr: "(tau) aborted\n",
          exitCode: null,
          truncated: false,
        };
      }
      if (request.method === "cancel") {
        return { accepted: true };
      }
      throw new Error(`unexpected ${request.method}`);
    });
    const backend = createFlySpriteToolExecutionBackend({
      sprite,
      cwd: "/home/sprite/repo",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(backend.runBash("sleep 10", { signal: controller.signal })).resolves.toEqual({
      output: "(tau) aborted\n",
      stdout: "",
      stderr: "(tau) aborted\n",
      exitCode: null,
      truncated: false,
    });

    expect(requests.map((request) => request.method)).toEqual(["exec", "cancel"]);
    expect(requests[1].targetId).toBe(requests[0].id);
  });

  it("routes filesystem helpers through the persistent worker", async () => {
    const requests = [];
    const sprite = createFakeSprite((request) => {
      requests.push(request);
      if (request.method === "readFile") {
        return { content: "hello" };
      }
      if (request.method === "readFileBinary") {
        return { contentBase64: Buffer.from("image").toString("base64"), bytes: 5 };
      }
      if (request.method === "writeFile") {
        return {
          path: request.path,
          bytes: Buffer.from(request.contentBase64, "base64").byteLength,
          lines: Buffer.from(request.contentBase64, "base64").toString("utf-8").split("\n").length,
        };
      }
      if (request.method === "listDir") {
        return {
          entries: [{ name: "file.txt", isDirectory: false, isSymlink: false }],
        };
      }
      throw new Error(`unexpected ${request.method}`);
    });
    const backend = createFlySpriteToolExecutionBackend({
      sprite,
      cwd: "/home/sprite/repo",
    });

    await expect(backend.readFile("/home/sprite/repo/file.txt")).resolves.toEqual({
      path: "/home/sprite/repo/file.txt",
      content: "hello",
    });
    await expect(backend.readFileBinary("/home/sprite/repo/image.png")).resolves.toMatchObject({
      path: "/home/sprite/repo/image.png",
      bytes: 5,
    });
    await expect(backend.writeFile("/home/sprite/repo/file.txt", "hello\nworld")).resolves.toEqual({
      path: "/home/sprite/repo/file.txt",
      bytes: 11,
      lines: 2,
    });
    await expect(
      backend.writeFileBinary("/home/sprite/repo/image.bin", Buffer.from([0, 255])),
    ).resolves.toEqual({
      path: "/home/sprite/repo/image.bin",
      bytes: 2,
    });
    await expect(backend.listDir("/home/sprite/repo")).resolves.toEqual({
      path: "/home/sprite/repo",
      entries: [{ name: "file.txt", isDirectory: false, isSymlink: false }],
    });

    expect(sprite.calls).toHaveLength(1);
    expect(requests.map((request) => request.method)).toEqual([
      "readFile",
      "readFileBinary",
      "writeFile",
      "writeFile",
      "listDir",
    ]);
    expect(requests[3].contentBase64).toBe(Buffer.from([0, 255]).toString("base64"));
  });

  it("parses worker responses split across many small stdout chunks", async () => {
    const sprite = createFakeSprite(
      (request) => {
        if (request.method === "readFile") {
          return { content: "hello from chunks" };
        }
        throw new Error(`unexpected ${request.method}`);
      },
      { chunkSize: 1 },
    );
    const backend = createFlySpriteToolExecutionBackend({
      sprite,
      cwd: "/home/sprite/repo",
    });

    await expect(backend.readFile("/home/sprite/repo/file.txt")).resolves.toEqual({
      path: "/home/sprite/repo/file.txt",
      content: "hello from chunks",
    });
  });
});
