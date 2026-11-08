import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupWorkspaceRootOnStartup,
  prepareWorkspace,
} from "../dist/core/telegram/workspace.js";

// Workspaces are prepared with real Git. Only `gh repo clone` is replaced, by a script that clones
// local fixture repositories, and every command records the GH_CONFIG_DIR it received.
describe("telegram workspace", () => {
  const originalPath = process.env.PATH;
  const tempRoots = [];
  let fixtures;
  let log;

  function git(cwd, ...args) {
    return execFileSync(
      "git",
      ["-c", "user.name=Tau Test", "-c", "user.email=test@example.com", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  }

  async function createOrigin(repo, files, branches = {}) {
    const path = join(fixtures, "origins", repo);
    await mkdir(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    for (const [branch, branchFiles] of [["main", files], ...Object.entries(branches)]) {
      if (branch !== "main") git(path, "checkout", "-q", "-b", branch);
      for (const [file, content] of Object.entries(branchFiles)) {
        await mkdir(join(path, file, ".."), { recursive: true });
        await writeFile(join(path, file), content);
      }
      git(path, "add", ".");
      git(path, "commit", "-q", "-m", branch);
      git(path, "checkout", "-q", "main");
    }
    return path;
  }

  async function commandLog() {
    const text = await readFile(log, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [command, ghConfigDir] = line.split("\t");
        return { command, ghConfigDir };
      });
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "tau-telegram-git-"));
    log = join(fixtures, "commands.log");
    const bin = join(fixtures, "bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\nprintf 'gh\\t%s\\n' "$GH_CONFIG_DIR" >> '${log}'\n` +
        `[ "$1 $2" = "repo clone" ] || exit 2\nexec '${realGit}' clone -q --bare '${fixtures}/origins/'"$3" "$4"\n`,
    );
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nprintf 'git\\t%s\\n' "$GH_CONFIG_DIR" >> '${log}'\nexec '${realGit}' "$@"\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    await chmod(join(bin, "git"), 0o755);
    await createOrigin("owner/tau", { "README.md": "tau" });
    await createOrigin(
      "owner/cowork",
      { "packages/core/index.js": "main" },
      { feature: { "packages/core/index.js": "feature" } },
    );
    process.env.PATH = `${bin}:${originalPath}`;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await rm(fixtures, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(log, { force: true });
    const roots = tempRoots.splice(0, tempRoots.length);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createWorkspaceRoot() {
    const root = await mkdtemp(join(tmpdir(), "tau-telegram-workspace-"));
    tempRoots.push(root);
    return join(root, "workspaces");
  }

  const projects = {
    tau: { repo: "owner/tau" },
    cowork: { repo: "owner/cowork", ref: "feature", workingDirectory: "packages/core" },
    platform: {
      projectIds: ["tau", "cowork"],
      persona: "gpt-5.6-sol-coder:high",
      instructions: "Coordinate changes across both repositories.",
    },
  };

  it("prepares composite workspaces from refreshed caches with member refs and root context", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const result = await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "platform",
      project: projects.platform,
      projects,
      workspaceRoot,
    });

    expect(result.sessionCwd).toBe(result.workspacePath);
    expect(result.provisionTargets).toEqual([
      {
        projectId: "tau",
        repositoryRoot: join(result.workspacePath, "tau"),
        cwd: join(result.workspacePath, "tau"),
      },
      {
        projectId: "cowork",
        repositoryRoot: join(result.workspacePath, "cowork"),
        cwd: join(result.workspacePath, "cowork", "packages", "core"),
      },
    ]);
    expect(await readFile(join(result.workspacePath, "tau", "README.md"), "utf8")).toBe("tau");
    expect(
      await readFile(join(result.workspacePath, "cowork", "packages", "core", "index.js"), "utf8"),
    ).toBe("feature");
    // Members push to the real origin, not to the shared local cache.
    expect(git(join(result.workspacePath, "cowork"), "remote", "get-url", "origin")).toBe(
      join(fixtures, "origins", "owner", "cowork"),
    );
    expect(
      JSON.parse(await readFile(join(result.workspacePath, ".tau", "config.json"), "utf8")),
    ).toEqual({});
    const agents = await readFile(join(result.workspacePath, "AGENTS.md"), "utf8");
    expect(agents).toContain("`tau/`");
    expect(agents).toContain("`cowork/`");
    expect(agents).toContain(projects.platform.instructions);

    // A later session reuses and refreshes the caches instead of cloning them again.
    const origin = join(fixtures, "origins", "owner", "tau");
    await writeFile(join(origin, "README.md"), "tau v2");
    git(origin, "commit", "-q", "-am", "v2");
    const configuredProject = {
      ...projects.platform,
      subagents: { launchModels: ["openai/gpt-5.6-sol:high"] },
    };
    await rm(log, { force: true });
    let configured;
    try {
      configured = await prepareWorkspace({
        sessionId: "def67890",
        projectId: "platform",
        project: configuredProject,
        projects: { ...projects, platform: configuredProject },
        workspaceRoot,
      });
    } finally {
      git(origin, "reset", "-q", "--hard", "HEAD~1");
    }

    expect((await commandLog()).filter(({ command }) => command === "gh")).toEqual([]);
    expect(await readFile(join(configured.workspacePath, "tau", "README.md"), "utf8")).toBe(
      "tau v2",
    );
    expect(
      JSON.parse(await readFile(join(configured.workspacePath, ".tau", "config.json"), "utf8")),
    ).toEqual({ subagents: { launchModels: ["openai/gpt-5.6-sol:high"] } });
  });

  it("keeps concurrent bot environments separate through cache creation and refresh", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const envs = [
      { GH_CONFIG_DIR: "/first/gh", GH_TOKEN: "" },
      { GH_CONFIG_DIR: "/second/gh", GH_TOKEN: "" },
    ];

    const prepared = await Promise.all(
      envs.map((env, index) =>
        prepareWorkspace({
          sessionId: `session-${index}`,
          projectId: "platform",
          project: projects.platform,
          projects,
          workspaceRoot,
          env,
        }),
      ),
    );

    for (const { workspacePath } of prepared) {
      expect(await readFile(join(workspacePath, "tau", "README.md"), "utf8")).toBe("tau");
    }
    const commands = await commandLog();
    expect(commands.some(({ command }) => command === "gh")).toBe(true);
    expect(new Set(commands.map(({ ghConfigDir }) => ghConfigDir))).toEqual(
      new Set(envs.map((env) => env.GH_CONFIG_DIR)),
    );
  });

  it("removes a composite workspace when member preparation fails", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const failing = {
      tau: projects.tau,
      missing: { repo: "owner/missing" },
      platform: { projectIds: ["tau", "missing"], persona: "gpt-5.6-sol-coder" },
    };

    await expect(
      prepareWorkspace({
        sessionId: "abc12345",
        projectId: "platform",
        project: failing.platform,
        projects: failing,
        workspaceRoot,
      }),
    ).rejects.toThrow();
    await expect(readdir(join(workspaceRoot, "platform", "abc12345"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reinitializes an existing repository cache when the configured repo changes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const prepare = (sessionId, repo) =>
      prepareWorkspace({ sessionId, projectId: "app", project: { repo }, workspaceRoot });

    await prepare("first", "owner/tau");
    const second = await prepare("second", "owner/cowork");

    expect((await commandLog()).filter(({ command }) => command === "gh")).toHaveLength(2);
    expect(await readdir(second.workspacePath)).toContain("packages");
    expect(await readdir(second.workspacePath)).not.toContain("README.md");
  });

  it("removes orphaned workspace entries while preserving active workspaces", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const activeWorkspace = join(workspaceRoot, "demo", "active");
    await mkdir(activeWorkspace, { recursive: true });
    await writeFile(join(activeWorkspace, "keep.txt"), "keep");
    await mkdir(join(workspaceRoot, "demo", "orphan"), { recursive: true });
    await writeFile(join(workspaceRoot, "demo", "orphan", "remove.txt"), "remove");
    await mkdir(join(workspaceRoot, "other", "stale"), { recursive: true });
    await writeFile(join(workspaceRoot, "stale-file.txt"), "remove");

    const result = await cleanupWorkspaceRootOnStartup(workspaceRoot, [activeWorkspace]);

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

    await expect(cleanupWorkspaceRootOnStartup(workspaceRoot, [workspaceRoot])).resolves.toEqual({
      workspaceRoot,
      deletedEntries: 0,
      failures: [],
    });
    expect(await readFile(join(workspaceRoot, "keep.txt"), "utf8")).toBe("keep");
  });

  it("reuses a persistent project directory without modifying it", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const directory = join(workspaceRoot, "me");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "notes.txt"), "keep");

    const result = await prepareWorkspace({
      sessionId: "abc12345",
      projectId: "me",
      project: { directory },
      projects: {},
      workspaceRoot,
    });

    expect(result).toEqual({
      workspacePath: directory,
      sessionCwd: directory,
      provisionTargets: [],
    });
    expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("keep");
    expect(await commandLog()).toEqual([]);
  });

  it("rejects a missing persistent project directory", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const directory = join(workspaceRoot, "missing");

    await expect(
      prepareWorkspace({
        sessionId: "abc12345",
        projectId: "me",
        project: { directory },
        projects: {},
        workspaceRoot,
      }),
    ).rejects.toThrow();
    expect(await commandLog()).toEqual([]);
  });
});
