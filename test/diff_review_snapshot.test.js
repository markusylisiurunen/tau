import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { captureDiffReviewSnapshot } from "../src/core/diff_review/snapshot.ts";

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr ?? result.stdout ?? "").trim() || `git ${args.join(" ")} failed`,
    );
  }
  return result.stdout ?? "";
}

function createRepoFixture() {
  const repo = mkdtempSync(join(tmpdir(), "tau-diff-review-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "foo.ts"), "export const value = 1;\n", "utf-8");
  writeFileSync(join(repo, "src", "bar.ts"), "export const removed = true;\n", "utf-8");
  writeFileSync(join(repo, "src", "baz.ts"), "export const draft = false;\n", "utf-8");

  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.name", "Tau Tests"]);
  runGit(repo, ["config", "user.email", "tau@example.com"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);

  writeFileSync(join(repo, "src", "foo.ts"), "export const value = 2;\n", "utf-8");
  writeFileSync(join(repo, "src", "baz.ts"), "export const draft = true;\n", "utf-8");
  writeFileSync(join(repo, "src", "qux.ts"), "export const untracked = true;\n", "utf-8");
  runGit(repo, ["rm", "src/bar.ts"]);
  runGit(repo, ["add", "src/foo.ts"]);

  return {
    repo: resolve(repo),
    gitRoot: resolve(runGit(repo, ["rev-parse", "--show-toplevel"]).trim()),
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

function createSpawnResult(output, overrides = {}) {
  return {
    stdout: "",
    stderr: "",
    output,
    exitCode: 0,
    captureLimitExceeded: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
    ...overrides,
  };
}

describe("diff_review snapshot", () => {
  it("captures a frozen diff snapshot with manifest and per-file patches", async () => {
    const fx = createRepoFixture();

    try {
      const snapshot = await captureDiffReviewSnapshot({
        cwd: fx.repo,
        diffArgs: ["--staged"],
      });

      expect(snapshot.repoRoot).toBe(fx.gitRoot);
      expect(snapshot.cwd).toBe(fx.repo);
      expect(snapshot.diffArgs).toEqual(["--staged"]);
      expect(snapshot.toDiffCommand()).toBe("git diff --staged");
      expect(snapshot.patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
      expect(snapshot.patch).toContain("diff --git a/src/bar.ts b/src/bar.ts");
      expect(snapshot.files).toEqual([
        {
          path: "src/bar.ts",
          status: "deleted",
          oldPath: "src/bar.ts",
        },
        {
          path: "src/foo.ts",
          status: "modified",
          newPath: "src/foo.ts",
        },
      ]);
      expect(snapshot.getFilePatch("src/foo.ts")).toContain("-export const value = 1;");
      expect(snapshot.getFilePatch("src/foo.ts")).toContain("+export const value = 2;");
      expect(snapshot.getFilePatch("src/bar.ts")).toContain("deleted file mode");
      expect(snapshot.getFilePatch("missing.ts")).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  it("captures plain /diff as the current working tree, including staged, unstaged, and untracked files", async () => {
    const fx = createRepoFixture();

    try {
      const snapshot = await captureDiffReviewSnapshot({
        cwd: fx.repo,
      });

      expect(snapshot.repoRoot).toBe(fx.gitRoot);
      expect(snapshot.cwd).toBe(fx.repo);
      expect(snapshot.diffArgs).toEqual([]);
      expect(snapshot.toDiffCommand()).toBe("current working tree");
      expect(snapshot.files).toEqual(
        expect.arrayContaining([
          {
            path: "src/bar.ts",
            status: "deleted",
            oldPath: "src/bar.ts",
          },
          {
            path: "src/baz.ts",
            status: "modified",
            newPath: "src/baz.ts",
          },
          {
            path: "src/foo.ts",
            status: "modified",
            newPath: "src/foo.ts",
          },
          {
            path: "src/qux.ts",
            status: "added",
            newPath: "src/qux.ts",
          },
        ]),
      );
      expect(snapshot.files).toHaveLength(4);
      expect(snapshot.patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
      expect(snapshot.patch).toContain("diff --git a/src/bar.ts b/src/bar.ts");
      expect(snapshot.patch).toContain("diff --git a/src/baz.ts b/src/baz.ts");
      expect(snapshot.patch).toContain("diff --git a/src/qux.ts b/src/qux.ts");
      expect(snapshot.getFilePatch("src/baz.ts")).toContain("+export const draft = true;");
      expect(snapshot.getFilePatch("src/qux.ts")).toContain("new file mode 100644");
      expect(snapshot.getFilePatch("src/qux.ts")).toContain("+export const untracked = true;");
    } finally {
      fx.cleanup();
    }
  });

  it("fails fast when any git command output is truncated", async () => {
    const spawn = async (_cmd, args) => {
      if (args[0] === "rev-parse") {
        return createSpawnResult("/repo\n");
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return createSpawnResult("M\0src/a.ts\0", { captureLimitExceeded: true });
      }
      return createSpawnResult("");
    };

    await expect(
      captureDiffReviewSnapshot({
        cwd: "/repo",
        deps: {
          spawn,
          env: { env: () => ({}) },
        },
      }),
    ).rejects.toThrow(
      "git diff --name-status -z HEAD output exceeded 2097152 bytes while capturing diff review snapshot",
    );
  });

  it("stops snapshot capture when diff review startup is aborted", async () => {
    const abortController = new AbortController();
    const spawn = async (_cmd, args) => {
      if (args[0] === "rev-parse") {
        return createSpawnResult("/repo\n");
      }
      return createSpawnResult("", { aborted: true, exitCode: null });
    };

    abortController.abort();

    await expect(
      captureDiffReviewSnapshot({
        cwd: "/repo",
        signal: abortController.signal,
        deps: {
          spawn,
          env: { env: () => ({}) },
        },
      }),
    ).rejects.toThrow("diff review start aborted");
  });

  it("preserves exact file paths from quoted git patch headers", async () => {
    const exactPath = " src/\todd name .ts ";
    const patch = [
      'diff --git "a/ src/\\todd name .ts " "b/ src/\\todd name .ts "',
      '--- "a/ src/\\todd name .ts "',
      '+++ "b/ src/\\todd name .ts "',
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");

    const spawn = async (_cmd, args) => {
      if (args[0] === "rev-parse") {
        return createSpawnResult("/repo\n");
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return createSpawnResult(`M\0${exactPath}\0`);
      }
      return createSpawnResult(patch);
    };

    const snapshot = await captureDiffReviewSnapshot({
      cwd: "/repo",
      deps: {
        spawn,
        env: { env: () => ({}) },
      },
    });

    expect(snapshot.files).toEqual([
      {
        path: exactPath,
        status: "modified",
        newPath: exactPath,
      },
    ]);
    expect(snapshot.getFilePatch(exactPath)).toBe(patch);
    expect(snapshot.getFilePatch(exactPath.trim())).toBeUndefined();
  });
});
