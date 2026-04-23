import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../dist/core/cli.js";

describe("cli", () => {
  it("rejects unknown options", () => {
    expect(() => parseCliArgs(["--bogus"], [])).toThrow("unknown option: --bogus");
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

  it("prints pdf-unpack help", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "tool", "pdf-unpack", "--help"], {
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tau tool pdf-unpack <file.pdf>");
    expect(result.stdout).toContain("requires pdftoppm from Poppler on PATH");
    expect(result.stderr).toBe("");
  });

  it("prints tool help text when tool command parsing fails", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "tool", "missing"], {
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown tool subcommand 'missing'");
    expect(result.stdout).toContain("tau tool <command>");
  });

  it("prints diff-tool help", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "diff-tool", "--help"], {
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tau diff-tool [--help]");
    expect(result.stdout).toContain("built-in browser diff review demo tool");
    expect(result.stderr).toBe("");
  });

  it("shows a clear error when diff-tool is launched outside a Tau diff review session", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "diff-tool"], {
      encoding: "utf8",
      env: {},
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tau diff-tool must be launched by Tau during /diff.");
    expect(result.stderr).toContain("missing TAU_DIFF_SOCKET");
    expect(result.stdout).toContain("tau diff-tool [--help]");
  });
});
