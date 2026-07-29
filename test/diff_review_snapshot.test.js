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
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
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
    stdout: output,
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
        source: { kind: "git_diff", diffArgs: ["--staged"] },
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
        source: { kind: "git_diff", diffArgs: [] },
      });

      expect(snapshot.repoRoot).toBe(fx.gitRoot);
      expect(snapshot.cwd).toBe(fx.repo);
      expect(snapshot.diffArgs).toEqual([]);
      expect(snapshot.toDiffCommand()).toBe("current working tree");
      expect(snapshot.files).toEqual([
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
      ]);
      expect(snapshot.patch).toMatch(
        /diff --git a\/src\/bar\.ts b\/src\/bar\.ts[\s\S]*diff --git a\/src\/baz\.ts b\/src\/baz\.ts[\s\S]*diff --git a\/src\/foo\.ts b\/src\/foo\.ts[\s\S]*diff --git a\/src\/qux\.ts b\/src\/qux\.ts/,
      );
      expect(snapshot.getFilePatch("src/baz.ts")).toContain("+export const draft = true;");
      expect(snapshot.getFilePatch("src/qux.ts")).toContain("new file mode 100644");
      expect(snapshot.getFilePatch("src/qux.ts")).toContain("+export const untracked = true;");
    } finally {
      fx.cleanup();
    }
  });

  it("keeps plain /diff file paths repo-root relative when launched from a subdirectory", async () => {
    const fx = createRepoFixture();

    try {
      const snapshot = await captureDiffReviewSnapshot({
        cwd: join(fx.repo, "packages", "app"),
        source: { kind: "git_diff", diffArgs: [] },
      });

      expect(snapshot.cwd).toBe(join(fx.repo, "packages", "app"));
      expect(snapshot.files.map((file) => file.path)).toEqual([
        "src/bar.ts",
        "src/baz.ts",
        "src/foo.ts",
        "src/qux.ts",
      ]);
      expect(snapshot.patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
      expect(snapshot.patch).not.toContain("diff --git a/../");
      expect(snapshot.getFilePatch("src/qux.ts")).toContain("+++ b/src/qux.ts");
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
        source: { kind: "git_diff", diffArgs: [] },
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
        source: { kind: "git_diff", diffArgs: [] },
        signal: abortController.signal,
        deps: {
          spawn,
          env: { env: () => ({}) },
        },
      }),
    ).rejects.toThrow("diff review start aborted");
  });

  it("captures multiple patch files as a custom review scope", async () => {
    const fx = createRepoFixture();

    try {
      const patchOne = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
      ].join("\n");
      const patchTwo = [
        "diff --git a/src/qux.ts b/src/qux.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/qux.ts",
        "@@ -0,0 +1 @@",
        "+export const untracked = true;",
      ].join("\n");
      writeFileSync(join(fx.repo, "selected-one.patch"), patchOne, "utf-8");
      writeFileSync(join(fx.repo, "selected-two.patch"), patchTwo, "utf-8");

      const snapshot = await captureDiffReviewSnapshot({
        cwd: fx.repo,
        source: {
          kind: "patch_files",
          patchFiles: ["selected-one.patch", "selected-two.patch"],
          scopeLabel: "selected hunks",
        },
      });

      expect(snapshot.toDiffCommand()).toBe("selected hunks");
      expect(snapshot.patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
      expect(snapshot.patch).toContain("diff --git a/src/qux.ts b/src/qux.ts");
      expect(snapshot.files).toEqual([
        { path: "src/foo.ts", status: "modified", oldPath: "src/foo.ts", newPath: "src/foo.ts" },
        { path: "src/qux.ts", status: "added", newPath: "src/qux.ts" },
      ]);
      expect(snapshot.getFilePatch("src/foo.ts")).toBe(patchOne);
      expect(snapshot.getFilePatch("src/qux.ts")).toBe(patchTwo);
    } finally {
      fx.cleanup();
    }
  });

  it("combines multiple patch-file sections for the same path", async () => {
    const fx = createRepoFixture();

    try {
      const patchOne = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
      ].join("\n");
      const patchTwo = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1 +1 @@",
        "-export const other = 1;",
        "+export const other = 2;",
      ].join("\n");
      writeFileSync(join(fx.repo, "selected-one.patch"), patchOne, "utf-8");
      writeFileSync(join(fx.repo, "selected-two.patch"), patchTwo, "utf-8");

      const snapshot = await captureDiffReviewSnapshot({
        cwd: fx.repo,
        source: {
          kind: "patch_files",
          patchFiles: ["selected-one.patch", "selected-two.patch"],
          scopeLabel: "selected hunks",
        },
      });

      expect(snapshot.files).toEqual([
        { path: "src/foo.ts", status: "modified", oldPath: "src/foo.ts", newPath: "src/foo.ts" },
      ]);
      expect(snapshot.getFilePatch("src/foo.ts")).toBe([patchOne, patchTwo].join("\n"));
    } finally {
      fx.cleanup();
    }
  });

  it("rejects patch files that exceed the snapshot capture limit", async () => {
    const fx = createRepoFixture();

    try {
      writeFileSync(join(fx.repo, "large.patch"), "x".repeat(2 * 1024 * 1024 + 1), "utf-8");

      await expect(
        captureDiffReviewSnapshot({
          cwd: fx.repo,
          source: { kind: "patch_files", patchFiles: ["large.patch"], scopeLabel: "large.patch" },
        }),
      ).rejects.toThrow(/patch files exceeded/);
    } finally {
      fx.cleanup();
    }
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
      return createSpawnResult(patch, {
        stderr: "warning: ambiguous ref\n",
        output: `warning: ambiguous ref\n${patch}`,
      });
    };

    const snapshot = await captureDiffReviewSnapshot({
      cwd: "/repo",
      source: { kind: "git_diff", diffArgs: [] },
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
    expect(snapshot.patch).not.toContain("ambiguous ref");
    expect(snapshot.getFilePatch(exactPath)).toBe(patch);
    expect(snapshot.getFilePatch(exactPath.trim())).toBeUndefined();
  });
});
