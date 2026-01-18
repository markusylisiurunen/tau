import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findAgentsFilesInScope } from "../dist/core/utils/context.js";

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

describe("project context agents from .tau/config.json", () => {
  it("includes additional AGENTS.md files configured in .tau/config.json", () => {
    const fx = setupFixture();

    try {
      writeFileSync(join(fx.repo, "AGENTS.md"), "# root agents\n");

      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      mkdirSync(join(fx.repo, "packages", "pkg1"), { recursive: true });

      writeFileSync(join(fx.repo, "packages", "pkg1", "AGENTS.md"), "# pkg1 agents\n");

      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ agentContextFiles: ["packages/pkg1/AGENTS.md"] }),
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

      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      mkdirSync(join(fx.repo, "docs"), { recursive: true });

      writeFileSync(join(fx.repo, "docs", "NOTES.md"), "# notes\n");

      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ agentContextFiles: ["docs/NOTES.md"] }),
      );

      const res = findAgentsFilesInScope(fx.repo, fx.home);

      expect(res).toEqual([join(fx.repo, "AGENTS.md")]);
    } finally {
      fx.cleanup();
    }
  });

  it("filters configured AGENTS.md files to the cwd ancestry/descendants", () => {
    const fx = setupFixture();

    try {
      const backend = join(fx.repo, "backend");
      const client = join(fx.repo, "client");
      const scripts = join(backend, "scripts");

      mkdirSync(backend, { recursive: true });
      mkdirSync(client, { recursive: true });
      mkdirSync(scripts, { recursive: true });

      writeFileSync(join(fx.repo, "AGENTS.md"), "# root agents\n");
      writeFileSync(join(backend, "AGENTS.md"), "# backend agents\n");
      writeFileSync(join(client, "AGENTS.md"), "# client agents\n");
      writeFileSync(join(scripts, "AGENTS.md"), "# scripts agents\n");

      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          agentContextFiles: ["backend/AGENTS.md", "client/AGENTS.md", "backend/scripts/AGENTS.md"],
        }),
      );

      const res = findAgentsFilesInScope(backend, fx.home);

      expect(res).toEqual([
        join(backend, "AGENTS.md"),
        join(fx.repo, "AGENTS.md"),
        join(scripts, "AGENTS.md"),
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("rejects symlinked agentContextFiles that escape home", () => {
    const fx = setupFixture();
    const outside = mkdtempSync(join(tmpdir(), "tau-context-outside-"));
    const outsideAbs = resolve(outside);

    try {
      writeFileSync(join(fx.repo, "AGENTS.md"), "# root agents\n");
      writeFileSync(join(outsideAbs, "AGENTS.md"), "# outside agents\n");

      const linksDir = join(fx.repo, "links");
      mkdirSync(linksDir, { recursive: true });
      symlinkSync(join(outsideAbs, "AGENTS.md"), join(linksDir, "AGENTS.md"));

      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ agentContextFiles: ["links/AGENTS.md"] }),
      );

      const res = findAgentsFilesInScope(fx.repo, fx.home);

      expect(res).toEqual([join(fx.repo, "AGENTS.md")]);
    } finally {
      rmSync(outsideAbs, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  it("ignores global agentContextFiles when cwd is outside home", () => {
    const fx = setupFixture();

    const outside = mkdtempSync(join(tmpdir(), "tau-context-outside-"));
    const outsideAbs = resolve(outside);

    try {
      writeFileSync(join(outsideAbs, "AGENTS.md"), "# outside agents\n");

      mkdirSync(join(fx.home, ".config", "tau"), { recursive: true });
      writeFileSync(join(fx.home, "AGENTS.md"), "# home agents\n");
      writeFileSync(
        join(fx.home, ".config", "tau", "config.json"),
        JSON.stringify({ agentContextFiles: ["AGENTS.md"] }),
      );

      const res = findAgentsFilesInScope(outsideAbs, fx.home);
      expect(res).toEqual([join(outsideAbs, "AGENTS.md")]);
    } finally {
      rmSync(outsideAbs, { recursive: true, force: true });
      fx.cleanup();
    }
  });
});
