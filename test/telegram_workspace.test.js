import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnWithCaptureMock } = vi.hoisted(() => ({
  spawnWithCaptureMock: vi.fn(),
}));

vi.mock("../dist/core/utils/spawn_capture.js", () => ({
  spawnWithCapture: spawnWithCaptureMock,
}));

import {
  cleanupWorkspaceRootsOnStartup,
  prepareWorkspace,
} from "../dist/core/telegram/workspace.js";

describe("telegram workspace", () => {
  const tempRoots = [];

  afterEach(async () => {
    spawnWithCaptureMock.mockReset();

    const roots = tempRoots.splice(0, tempRoots.length);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createWorkspaceRoot() {
    const root = await mkdtemp(join(tmpdir(), "tau-telegram-workspace-"));
    tempRoots.push(root);
    return join(root, "workspaces");
  }

  it("removes orphaned workspace entries while preserving active workspaces", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const activeWorkspace = join(workspaceRoot, "demo", "active");
    await mkdir(activeWorkspace, { recursive: true });
    await writeFile(join(activeWorkspace, "keep.txt"), "keep");
    await mkdir(join(workspaceRoot, "demo", "orphan"), { recursive: true });
    await writeFile(join(workspaceRoot, "demo", "orphan", "remove.txt"), "remove");
    await mkdir(join(workspaceRoot, "other", "stale"), { recursive: true });
    await writeFile(join(workspaceRoot, "stale-file.txt"), "remove");

    const [result] = await cleanupWorkspaceRootsOnStartup(
      [workspaceRoot, workspaceRoot],
      [activeWorkspace],
    );

    expect(result).toEqual({
      workspaceRoot,
      deletedEntries: 3,
      failures: [],
    });
    expect(await readFile(join(activeWorkspace, "keep.txt"), "utf8")).toBe("keep");
    expect(await readdir(workspaceRoot)).toEqual(["demo"]);
    expect(await readdir(join(workspaceRoot, "demo"))).toEqual(["active"]);
  });

  it("preserves a workspace that is also configured as a cleanup root", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "keep.txt"), "keep");

    await expect(cleanupWorkspaceRootsOnStartup([workspaceRoot], [workspaceRoot])).resolves.toEqual(
      [
        {
          workspaceRoot,
          deletedEntries: 0,
          failures: [],
        },
      ],
    );
    expect(await readFile(join(workspaceRoot, "keep.txt"), "utf8")).toBe("keep");
  });

  it("treats a missing workspace root as already clean", async () => {
    const workspaceRoot = await createWorkspaceRoot();

    await expect(cleanupWorkspaceRootsOnStartup([workspaceRoot], [])).resolves.toEqual([
      {
        workspaceRoot,
        deletedEntries: 0,
        failures: [],
      },
    ]);
  });

  it("clones repository through a persistent cache and logs phase durations", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const cachePath = join(`${workspaceRoot}-repo-cache`, "tau.git");
    const logs = [];

    spawnWithCaptureMock.mockImplementation(async (command, commandArgs, options) => {
      if (command === "gh") {
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cached" };
      }

      if (command === "git") {
        if (commandArgs[2] === "remote" && commandArgs[3] === "get-url") {
          return { exitCode: 0, output: "git@github.com:owner/repo.git\n" };
        }

        if (commandArgs[0] === "clone") {
          const workspacePath = commandArgs[3];
          await mkdir(join(workspacePath, "packages", "core"), { recursive: true });
          return { exitCode: 0, output: "cloned from cache" };
        }

        if (commandArgs[2] === "checkout") {
          return { exitCode: 0, output: "Already on 'main'" };
        }

        return { exitCode: 0, output: "" };
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
      ["repo", "clone", "owner/repo", cachePath, "--", "--bare"],
      expect.any(Object),
    );
    expect(spawnWithCaptureMock).toHaveBeenCalledWith(
      "git",
      ["clone", "--shared", cachePath, result.workspacePath],
      expect.any(Object),
    );

    const cloneLog = logs.find((entry) => entry.message === "repository clone complete");
    expect(cloneLog?.data).toEqual(
      expect.objectContaining({
        cachePath,
        durationMs: expect.any(Number),
      }),
    );

    const checkoutLog = logs.find((entry) => entry.message === "ref checkout complete");
    expect(checkoutLog?.data).toEqual(
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

  it("prepares composite workspaces with generated root context", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const bootstrapCalls = [];

    spawnWithCaptureMock.mockImplementation(async (command, commandArgs, options) => {
      if (command === "gh") {
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cached" };
      }

      if (command === "git") {
        if (commandArgs[2] === "remote" && commandArgs[3] === "get-url") {
          const repo = commandArgs[1].endsWith("tau.git") ? "tau" : "cowork";
          return { exitCode: 0, output: `git@github.com:owner/${repo}.git\n` };
        }

        if (commandArgs[0] === "clone") {
          const cachePath = commandArgs[2];
          const memberPath = commandArgs[3];
          await mkdir(memberPath, { recursive: true });
          await writeFile(join(memberPath, "AGENTS.md"), "member instructions");
          if (cachePath.endsWith("cowork.git")) {
            await mkdir(join(memberPath, "packages", "core"), { recursive: true });
            await writeFile(join(memberPath, "packages", "AGENTS.md"), "package instructions");
            await writeFile(join(memberPath, "packages", "core", "AGENTS.md"), "core instructions");
          }
          return { exitCode: 0, output: "cloned from cache" };
        }

        return { exitCode: 0, output: "" };
      }

      if (options.shell) {
        bootstrapCalls.push({ command, cwd: options.cwd });
        return { exitCode: 0, output: "bootstrapped" };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const projects = {
      tau: {
        repo: "owner/tau",
        bootstrapCommands: ["bootstrap tau"],
        backgroundBootstrapCommands: ["watch tau"],
      },
      cowork: {
        repo: "owner/cowork",
        ref: "main",
        workingDirectory: "packages/core",
        bootstrapCommands: ["bootstrap cowork"],
        backgroundBootstrapCommands: ["watch cowork"],
      },
      platform: {
        projectIds: ["tau", "cowork"],
        persona: "gpt-5.6-sol-coder:high",
        bootstrapCommands: ["bootstrap platform"],
        instructions: "Coordinate changes across both repositories.",
      },
    };
    const result = await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "platform",
      project: projects.platform,
      projects,
      workspaceRoot,
      defaultWorkspaceRoot: workspaceRoot,
    });

    expect(result.sessionCwd).toBe(result.workspacePath);
    expect(bootstrapCalls).toEqual([
      { command: "bootstrap tau", cwd: join(result.workspacePath, "tau") },
      {
        command: "bootstrap cowork",
        cwd: join(result.workspacePath, "cowork", "packages", "core"),
      },
      { command: "bootstrap platform", cwd: result.workspacePath },
    ]);
    expect(result.memberBackgroundBootstrapCommands).toEqual([
      { commands: ["watch tau"], cwd: join(result.workspacePath, "tau") },
      {
        commands: ["watch cowork"],
        cwd: join(result.workspacePath, "cowork", "packages", "core"),
      },
    ]);

    expect(
      JSON.parse(await readFile(join(result.workspacePath, ".tau", "config.json"), "utf8")),
    ).toEqual({
      agentContextFiles: [
        "tau/AGENTS.md",
        "cowork/AGENTS.md",
        "cowork/packages/AGENTS.md",
        "cowork/packages/core/AGENTS.md",
      ],
    });
    const agents = await readFile(join(result.workspacePath, "AGENTS.md"), "utf8");
    expect(agents).toContain("`tau/`: repository `owner/tau`");
    expect(agents).toContain("`cowork/`: repository `owner/cowork`, ref `main`");
    expect(agents).toContain("Coordinate changes across both repositories.");
    expect(agents).not.toContain("report verification");
  });

  it("removes a composite workspace when member preparation fails", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const workspacePath = join(workspaceRoot, "platform", "abc12345");

    spawnWithCaptureMock.mockImplementation(async (command, commandArgs) => {
      if (command === "gh") {
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cached" };
      }
      if (command === "git" && commandArgs[2] === "remote") {
        return { exitCode: 0, output: "git@github.com:owner/repo.git\n" };
      }
      if (command === "git" && commandArgs[0] === "clone") {
        if (commandArgs[2].endsWith("beta.git")) {
          return { exitCode: 1, output: "clone failed" };
        }
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cloned" };
      }
      return { exitCode: 0, output: "" };
    });

    const projects = {
      alpha: { repo: "owner/alpha" },
      beta: { repo: "owner/beta" },
      platform: {
        projectIds: ["alpha", "beta"],
        persona: "gpt-5.6-sol-coder",
      },
    };
    await expect(
      prepareWorkspace({
        sessionId: "abc12345",
        projectId: "platform",
        project: projects.platform,
        projects,
        workspaceRoot,
        defaultWorkspaceRoot: workspaceRoot,
      }),
    ).rejects.toThrow("repository clone from cache failed");
    await expect(readdir(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fetches an existing repository cache before cloning", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const cachePath = join(`${workspaceRoot}-repo-cache`, "tau.git");
    await mkdir(cachePath, { recursive: true });

    spawnWithCaptureMock.mockImplementation(async (command, commandArgs) => {
      if (command !== "git") {
        throw new Error(`unexpected command: ${command}`);
      }

      if (commandArgs[2] === "config" && commandArgs[3] === "--get") {
        return { exitCode: 0, output: "owner/repo\n" };
      }

      if (commandArgs[2] === "remote" && commandArgs[3] === "get-url") {
        return { exitCode: 0, output: "git@github.com:owner/repo.git\n" };
      }

      if (commandArgs[0] === "clone") {
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cloned from cache" };
      }

      return { exitCode: 0, output: "" };
    });

    const result = await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "tau",
      workspaceRoot,
      project: {
        repo: "owner/repo",
      },
    });

    expect(result.workspacePath).toBe(join(workspaceRoot, "tau", "abc12345"));
    expect(spawnWithCaptureMock).toHaveBeenCalledWith(
      "git",
      ["-C", cachePath, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"],
      expect.any(Object),
    );
    expect(spawnWithCaptureMock).not.toHaveBeenCalledWith(
      "gh",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("reinitializes an existing repository cache when the configured repo changes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const cachePath = join(`${workspaceRoot}-repo-cache`, "tau.git");
    await mkdir(cachePath, { recursive: true });
    let initialized = false;

    spawnWithCaptureMock.mockImplementation(async (command, commandArgs) => {
      if (command === "gh") {
        initialized = true;
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cached" };
      }

      if (command !== "git") {
        throw new Error(`unexpected command: ${command}`);
      }

      if (commandArgs[2] === "config" && commandArgs[3] === "--get") {
        return { exitCode: 0, output: "owner/old-repo\n" };
      }

      if (commandArgs[2] === "remote" && commandArgs[3] === "get-url") {
        return {
          exitCode: 0,
          output: initialized
            ? "git@github.com:owner/new-repo.git\n"
            : "git@github.com:owner/old-repo.git\n",
        };
      }

      if (commandArgs[0] === "clone") {
        await mkdir(commandArgs[3], { recursive: true });
        return { exitCode: 0, output: "cloned from cache" };
      }

      return { exitCode: 0, output: "" };
    });

    await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "tau",
      workspaceRoot,
      project: {
        repo: "owner/new-repo",
      },
    });

    expect(spawnWithCaptureMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/new-repo", cachePath, "--", "--bare"],
      expect.any(Object),
    );
    expect(spawnWithCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["-C", cachePath, "fetch", "--prune", "origin"],
      expect.any(Object),
    );
  });

  it("fails when repository cache clone fails", async () => {
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
    ).rejects.toThrow("repository cache clone failed with exit code 1");

    expect(spawnWithCaptureMock).toHaveBeenCalledTimes(1);
    const cloneFailureLog = logs.find((entry) => entry.message === "repository cache clone failed");
    expect(cloneFailureLog?.level).toBe("error");
  });
});
