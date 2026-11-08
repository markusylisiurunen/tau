import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalTuiSessionAttributes } from "../dist/tui/session_creation_attributes.js";

function createRepository(path, remote) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
}

describe("session creation attributes", () => {
  it("deduplicates and bounds repository attributes for large workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-session-attributes-"));
    try {
      const repositories = Array.from(
        { length: 3 },
        (_, index) =>
          `github.com/example/repository-${String(index).padStart(2, "0")}-${"x".repeat(400)}`,
      );
      for (const [index, repository] of repositories.entries()) {
        createRepository(join(root, `repo-${String(index).padStart(2, "0")}`), `${repository}.git`);
      }
      createRepository(join(root, "repo-00-duplicate"), `${repositories[0]}.git`);

      const attributes = createLocalTuiSessionAttributes(root);
      const included = attributes.repository.split(",");

      expect(attributes.repository.length).toBeLessThanOrEqual(1_024);
      expect(included).toEqual(repositories.slice(0, 2));
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
