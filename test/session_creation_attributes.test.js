import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeRepositoryReference } from "../dist/core/utils/repository.js";
import { createLocalTuiSessionAttributes } from "../dist/tui/session_creation_attributes.js";

function createRepository(path, remote) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
}

describe("session creation attributes", () => {
  it("normalizes conventional repository references", () => {
    expect(normalizeRepositoryReference("git@github.com:owner/repo.git")).toBe(
      "github.com/owner/repo",
    );
    expect(normalizeRepositoryReference("https://GitHub.com/owner/repo.git/")).toBe(
      "github.com/owner/repo",
    );
    expect(normalizeRepositoryReference("owner/repo", { defaultHost: "github.com" })).toBe(
      "github.com/owner/repo",
    );
  });

  it("builds one local TUI repository attribute from direct child repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-session-attributes-"));
    try {
      createRepository(join(root, "alpha"), "git@github.com:example/alpha.git");
      createRepository(join(root, "beta"), "https://github.com/example/beta.git");

      expect(createLocalTuiSessionAttributes(root)).toEqual({
        source: "tui",
        repository: "github.com/example/alpha,github.com/example/beta",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates and bounds repository attributes for large workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-session-attributes-"));
    try {
      const repositories = Array.from(
        { length: 24 },
        (_, index) =>
          `github.com/example/repository-${String(index).padStart(2, "0")}-${"x".repeat(40)}`,
      );
      for (const [index, repository] of repositories.entries()) {
        createRepository(join(root, `repo-${String(index).padStart(2, "0")}`), `${repository}.git`);
      }
      createRepository(join(root, "repo-duplicate"), `${repositories[0]}.git`);

      const attributes = createLocalTuiSessionAttributes(root);
      const included = attributes.repository.split(",");

      expect(attributes.repository.length).toBeLessThanOrEqual(1_024);
      expect(included).toEqual(repositories.slice(0, included.length));
      expect(included.length).toBeLessThan(repositories.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits an individually oversized repository reference", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-session-attributes-"));
    try {
      createRepository(root, `https://github.com/example/${"x".repeat(1_024)}.git`);

      expect(createLocalTuiSessionAttributes(root)).toEqual({ source: "tui" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
