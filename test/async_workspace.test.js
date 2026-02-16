import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnWithCaptureMock } = vi.hoisted(() => ({
  spawnWithCaptureMock: vi.fn(),
}));

vi.mock("../dist/core/utils/spawn_capture.js", () => ({
  spawnWithCapture: spawnWithCaptureMock,
}));

import { cleanupWorkspaceRootsOnStartup, prepareWorkspace } from "../dist/core/async/workspace.js";

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

  it("wipes workspace root contents on startup", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await mkdir(join(workspaceRoot, "demo", "s-123"), { recursive: true });
    await mkdir(join(workspaceRoot, "demo", "s-456"), { recursive: true });
    await writeFile(join(workspaceRoot, "stale-file.txt"), "stale");

    const [result] = await cleanupWorkspaceRootsOnStartup([workspaceRoot]);

    expect(result).toEqual(
      expect.objectContaining({
        workspaceRoot,
        deletedEntries: 2,
        failures: [],
      }),
    );
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it("returns failure records for non-directory roots and continues", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "tau-async-workspace-"));
    tempRoots.push(tempRoot);
    const notDirectoryPath = join(tempRoot, "not-a-directory");
    await writeFile(notDirectoryPath, "value");

    const [missingRoot, nonDirectoryRoot] = await cleanupWorkspaceRootsOnStartup([
      join(tempRoot, "missing-root"),
      notDirectoryPath,
    ]);

    expect(missingRoot).toEqual(
      expect.objectContaining({
        deletedEntries: 0,
        failures: [],
      }),
    );
    expect(nonDirectoryRoot).toEqual(
      expect.objectContaining({
        deletedEntries: 0,
        failures: [
          expect.objectContaining({
            path: notDirectoryPath,
          }),
        ],
      }),
    );
  });

  it("clones repository and logs phase durations", async () => {
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
      ["repo", "clone", "owner/repo", result.workspacePath],
      expect.any(Object),
    );

    const cloneLog = logs.find((entry) => entry.message === "repository clone complete");
    expect(cloneLog?.data).toEqual(
      expect.objectContaining({
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

  it("fails when repository clone fails", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const logs = [];

    spawnWithCaptureMock.mockImplementation(async (command) => {
      if (command === "gh") {
        return { exitCode: 1, output: "clone failed" };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      prepareWorkspace({
        sessionId: "abc12345",
        projectId: "tau",
        workspaceRoot,
        project: {
          repo: "owner/repo",
          ref: "main",
        },
        onLog: (entry) => logs.push(entry),
      }),
    ).rejects.toThrow("gh repo clone failed with exit code 1");

    expect(spawnWithCaptureMock).toHaveBeenCalledTimes(1);
    const cloneFailureLog = logs.find((entry) => entry.message === "gh repo clone failed");
    expect(cloneFailureLog?.level).toBe("error");
  });
});
