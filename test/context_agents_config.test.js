import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { findAgentsFilesInScope } from "../dist/utils/context.js";

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "tau-context-home-"));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });

  return {
    home: resolve(home),
    repo: resolve(repo),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe("project context agents from .tau-bedrock/config.json", () => {
  it("includes additional AGENTS.md files configured in .tau-bedrock/config.json", () => {
    const fx = setupFixture();

    try {
      writeFileSync(join(fx.repo, "AGENTS.md"), "# root agents\n");

      mkdirSync(join(fx.repo, ".tau-bedrock"), { recursive: true });
      mkdirSync(join(fx.repo, "packages", "pkg1"), { recursive: true });

      writeFileSync(join(fx.repo, "packages", "pkg1", "AGENTS.md"), "# pkg1 agents\n");

      writeFileSync(
        join(fx.repo, ".tau-bedrock", "config.json"),
        JSON.stringify({ agents: ["packages/pkg1/AGENTS.md"] }),
      );

      const res = findAgentsFilesInScope(fx.repo, fx.home);

      expect(res).toEqual([
        join(fx.repo, "AGENTS.md"),
        join(fx.repo, "packages", "pkg1", "AGENTS.md"),
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("ignores configured paths that are not AGENTS.md", () => {
    const fx = setupFixture();

    try {
      writeFileSync(join(fx.repo, "AGENTS.md"), "# root agents\n");

      mkdirSync(join(fx.repo, ".tau-bedrock"), { recursive: true });
      mkdirSync(join(fx.repo, "docs"), { recursive: true });

      writeFileSync(join(fx.repo, "docs", "NOTES.md"), "# notes\n");

      writeFileSync(
        join(fx.repo, ".tau-bedrock", "config.json"),
        JSON.stringify({ agents: ["docs/NOTES.md"] }),
      );

      const res = findAgentsFilesInScope(fx.repo, fx.home);

      expect(res).toEqual([join(fx.repo, "AGENTS.md")]);
    } finally {
      fx.cleanup();
    }
  });
});
