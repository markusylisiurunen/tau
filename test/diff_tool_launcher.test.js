import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { launchBuiltInDiffTool } from "../src/diff_tool/launcher.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function createChild() {
  const child = new EventEmitter();
  child.unref = vi.fn();
  spawn.mockReturnValueOnce(child);
  return child;
}

describe("built-in diff tool launcher", () => {
  it("launches the bundled CLI with the client-local review environment", async () => {
    const child = createChild();
    const env = { TAU_DIFF_SOCKET: "/client/review.sock", TAU_DIFF_TOKEN: "review-token" };
    const launched = launchBuiltInDiffTool({ cwd: "/client/workspace", env });

    expect(spawn).toHaveBeenLastCalledWith(
      process.execPath,
      [fileURLToPath(new URL("../src/main.js", import.meta.url)), "diff-tool"],
      { cwd: "/client/workspace", env, stdio: "ignore", detached: true },
    );
    expect(child.unref).not.toHaveBeenCalled();

    child.emit("spawn");
    await launched;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects a failed process launch", async () => {
    const child = createChild();
    const error = Object.assign(new Error("launch failed"), { code: "ENOENT" });
    const launched = launchBuiltInDiffTool({ cwd: "/client/workspace", env: {} });
    const rejected = expect(launched).rejects.toBe(error);

    child.emit("error", error);
    await rejected;
    expect(child.unref).not.toHaveBeenCalled();
  });
});
