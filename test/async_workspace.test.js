import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnWithCaptureMock } = vi.hoisted(() => ({
  spawnWithCaptureMock: vi.fn(),
}));

vi.mock("../dist/core/utils/spawn_capture.js", () => ({
  spawnWithCapture: spawnWithCaptureMock,
}));

import { prepareWorkspace } from "../dist/core/async/workspace.js";

describe("async workspace", () => {
  const tempRoots = [];

  afterEach(async () => {
    spawnWithCaptureMock.mockReset();

    const roots = tempRoots.splice(0, tempRoots.length);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createWorkspaceRoot() {
    const root = await mkdtemp(join(tmpdir(), "tau-async-workspace-"));
    tempRoots.push(root);
    return join(root, "workspaces");
  }

  it("uses shallow clone flags when ref is configured", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const logs = [];

    spawnWithCaptureMock.mockImplementation(async (command, commandArgs, options) => {
      if (command === "gh") {
        const workspacePath = commandArgs[3];
        await mkdir(join(workspacePath, "packages", "core"), { recursive: true });
        return { exitCode: 0, output: "cloned" };
      }

      if (command === "git") {
        return { exitCode: 0, output: "Already on 'main'" };
      }

      if (command === "npm ci") {
        expect(options).toEqual(expect.objectContaining({ shell: true }));
        return { exitCode: 0, output: "installed" };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const result = await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "tau",
      workspaceRoot,
      project: {
        repo: "owner/repo",
        ref: "main",
        workingDirectory: "packages/core",
        bootstrapCommands: ["npm ci"],
      },
      onLog: (entry) => logs.push(entry),
    });

    expect(result.sessionCwd).toBe(join(result.workspacePath, "packages", "core"));

    expect(spawnWithCaptureMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      [
        "repo",
        "clone",
        "owner/repo",
        result.workspacePath,
        "--",
        "--depth=1",
        "--single-branch",
        "--branch",
        "main",
      ],
      expect.any(Object),
    );

    const cloneLog = logs.find((entry) => entry.message === "repository clone complete");
    expect(cloneLog?.data).toEqual(
      expect.objectContaining({
        mode: "shallow",
        ref: "main",
        durationMs: expect.any(Number),
      }),
    );

    const bootstrapLog = logs.find((entry) => entry.message === "bootstrap command complete");
    expect(bootstrapLog?.data).toEqual(
      expect.objectContaining({
        command: "npm ci",
        durationMs: expect.any(Number),
      }),
    );
  });

  it("falls back to full clone when shallow clone fails", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const logs = [];

    let cloneAttempt = 0;
    spawnWithCaptureMock.mockImplementation(async (command, commandArgs) => {
      if (command === "gh") {
        cloneAttempt += 1;
        const workspacePath = commandArgs[3];

        if (cloneAttempt === 1) {
          return { exitCode: 1, output: "shallow clone failed" };
        }

        await mkdir(workspacePath, { recursive: true });
        return { exitCode: 0, output: "full clone success" };
      }

      if (command === "git") {
        return { exitCode: 0, output: "" };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const result = await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "tau",
      workspaceRoot,
      project: {
        repo: "owner/repo",
        ref: "main",
      },
      onLog: (entry) => logs.push(entry),
    });

    expect(result.workspacePath).toBe(join(workspaceRoot, "tau", "abc12345"));

    const cloneCalls = spawnWithCaptureMock.mock.calls.filter(([command]) => command === "gh");
    expect(cloneCalls).toHaveLength(2);

    expect(cloneCalls[0][1]).toEqual([
      "repo",
      "clone",
      "owner/repo",
      result.workspacePath,
      "--",
      "--depth=1",
      "--single-branch",
      "--branch",
      "main",
    ]);

    expect(cloneCalls[1][1]).toEqual(["repo", "clone", "owner/repo", result.workspacePath]);

    const fallbackLog = logs.find(
      (entry) => entry.message === "shallow clone failed, retrying full clone",
    );
    expect(fallbackLog?.data).toEqual(
      expect.objectContaining({
        exitCode: 1,
      }),
    );

    const cloneCompleteLog = logs.find((entry) => entry.message === "repository clone complete");
    expect(cloneCompleteLog?.data).toEqual(
      expect.objectContaining({
        mode: "full",
        durationMs: expect.any(Number),
      }),
    );
  });
});
