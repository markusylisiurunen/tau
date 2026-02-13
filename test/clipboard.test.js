import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../dist/tui/clipboard.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function createChildProcess(result) {
  const child = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();

  stdin.end = vi.fn();
  child.stderr = stderr;
  child.stdin = stdin;

  queueMicrotask(() => {
    if (result.type === "spawn-error") {
      child.emit("error", result.error);
      return;
    }

    if (result.stderr) {
      stderr.emit("data", Buffer.from(result.stderr));
    }

    child.emit("close", result.code);
  });

  return child;
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.clearAllMocks();
});

describe("copyTextToClipboard", () => {
  it("uses pbcopy on macOS", async () => {
    setPlatform("darwin");
    spawnMock.mockImplementationOnce(() => createChildProcess({ type: "close", code: 0 }));

    await copyTextToClipboard("hello");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("pbcopy", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
  });

  it("tries Linux providers in order until one succeeds", async () => {
    setPlatform("linux");

    spawnMock
      .mockImplementationOnce(() =>
        createChildProcess({
          type: "spawn-error",
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
        }),
      )
      .mockImplementationOnce(() => createChildProcess({ type: "close", code: 1 }))
      .mockImplementationOnce(() => createChildProcess({ type: "close", code: 0 }));

    await copyTextToClipboard("hello");

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock).toHaveBeenNthCalledWith(1, "wl-copy", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "xclip", ["-selection", "clipboard"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(3, "xsel", ["--clipboard", "--input"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
  });

  it("throws a clear missing-provider error when all Linux providers fail", async () => {
    setPlatform("linux");

    spawnMock
      .mockImplementationOnce(() =>
        createChildProcess({
          type: "spawn-error",
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
        }),
      )
      .mockImplementationOnce(() =>
        createChildProcess({
          type: "spawn-error",
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
        }),
      )
      .mockImplementationOnce(() =>
        createChildProcess({
          type: "spawn-error",
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
        }),
      );

    await expect(copyTextToClipboard("hello")).rejects.toThrow(/missing clipboard provider/i);
  });
});
