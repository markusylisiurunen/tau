import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnWithCapture } from "../dist/core/utils/spawn_capture.js";

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("spawnWithCapture", () => {
  it("completes process-group escalation after the leader exits", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-spawn-capture-"));
    const childPidPath = join(tempRoot, "child.pid");
    let childPid;

    try {
      const childScript = [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const leaderScript = [
        'import { spawn } from "node:child_process";',
        `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const abortController = new AbortController();
      const completion = spawnWithCapture(
        process.execPath,
        ["--input-type=module", "--eval", leaderScript],
        {
          detached: true,
          killProcessGroup: true,
          killGraceMs: 100,
          signal: abortController.signal,
        },
      );

      await waitFor(() => existsSync(childPidPath));
      childPid = Number(await readFile(childPidPath, "utf8"));
      expect(isProcessRunning(childPid)).toBe(true);

      abortController.abort();
      await expect(completion).resolves.toMatchObject({ aborted: true });
      await waitFor(() => !isProcessRunning(childPid));
    } finally {
      if (childPid && isProcessRunning(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
