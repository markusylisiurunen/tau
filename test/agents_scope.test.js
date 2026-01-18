import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAgentContextPathInScope } from "../dist/core/utils/agents_files.js";

describe("agent context path scoping", () => {
  const base = resolve(tmpdir(), "tau-agent-scope");
  const cwd = join(base, "backend");

  it("includes ancestor directories", () => {
    expect(isAgentContextPathInScope(join(base, "AGENTS.md"), cwd)).toBe(true);
  });

  it("includes descendant directories", () => {
    expect(isAgentContextPathInScope(join(base, "backend", "scripts", "AGENTS.md"), cwd)).toBe(
      true,
    );
  });

  it("excludes siblings", () => {
    expect(isAgentContextPathInScope(join(base, "client", "AGENTS.md"), cwd)).toBe(false);
  });

  it("avoids prefix false positives", () => {
    expect(isAgentContextPathInScope(join(base, "backendish", "AGENTS.md"), cwd)).toBe(false);
  });
});
