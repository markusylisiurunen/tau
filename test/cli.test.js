import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../dist/core/cli.js";

describe("cli", () => {
  it("parses --sandbox", () => {
    const options = parseCliArgs(["--sandbox"], []);
    expect(options.sandbox).toBe(true);
  });

  it("defaults sandbox to false", () => {
    const options = parseCliArgs([], []);
    expect(options.sandbox).toBe(false);
  });

  it("parses --caffeinated", () => {
    const options = parseCliArgs(["--caffeinated"], []);
    expect(options.caffeinated).toBe(true);
  });

  it("defaults caffeinated to false", () => {
    const options = parseCliArgs([], []);
    expect(options.caffeinated).toBe(false);
  });

  it("requires exact persona id matching", () => {
    expect(() => parseCliArgs(["--persona", "demo"], [{ id: "Demo" }])).toThrow(
      "unknown persona 'demo'",
    );
  });

  it("parses persona reasoning suffix", () => {
    const options = parseCliArgs(["--persona", "demo:high"], [{ id: "demo" }]);
    expect(options.personaId).toBe("demo");
    expect(options.reasoningOverride).toBe("high");
  });

  it("rejects invalid persona reasoning suffix", () => {
    expect(() => parseCliArgs(["--persona", "demo:ultra"], [{ id: "demo" }])).toThrow(
      "invalid reasoning level 'ultra'",
    );
  });

  it("requires exact risk level casing", () => {
    expect(() => parseCliArgs(["--risk", "READ-ONLY"], [])).toThrow(
      "invalid risk level 'READ-ONLY'",
    );
  });

  it("prints async help text when async command parsing fails", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "async"], {
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing async command or prompt");
    expect(result.stderr).toContain("\n\n");
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).toContain("tau async daemon");
  });
});
