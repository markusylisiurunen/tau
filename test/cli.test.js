import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../dist/core/cli.js";

describe("cli", () => {
  it("rejects unknown options", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow("unknown option: --bogus");
  });

  it("parses --caffeinated", () => {
    const options = parseCliArgs(["--caffeinated"]);
    expect(options.caffeinated).toBe(true);
  });

  it("defaults caffeinated to false", () => {
    const options = parseCliArgs([]);
    expect(options.caffeinated).toBe(false);
  });

  it("defers persona resolution until an execution environment exists", () => {
    const options = parseCliArgs(["--persona", "sandbox-persona"]);
    expect(options.personaId).toBe("sandbox-persona");
  });

  it("parses persona reasoning suffix", () => {
    const options = parseCliArgs(["--persona", "demo:high"]);
    expect(options.personaId).toBe("demo");
    expect(options.reasoningOverride).toBe("high");
  });

  it("rejects invalid persona reasoning suffix", () => {
    expect(() => parseCliArgs(["--persona", "demo:ultra"])).toThrow(
      "invalid reasoning level 'ultra'",
    );
  });

  it("does not substitute a host persona for unresolved server debug personas", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(
      process.execPath,
      [mainPath, "rpc", "--debug", "--persona", "sandbox-persona"],
      {
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "cannot resolve persona 'sandbox-persona' for --debug without an execution environment",
    );
    expect(result.stdout).toBe("");
  });

  it("prints telegram help text when telegram command parsing fails", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "telegram"], {
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --config-file <path>");
    expect(result.stderr).toContain("\n\n");
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).toContain("tau telegram --config-file <path>");
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

  it("rejects relative attach --new cwd before connecting", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(
      process.execPath,
      [mainPath, "attach", "--new", "--cwd", "relative/path", "ws://127.0.0.1:1"],
      {
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--new requires --cwd <absolute-path>");
    expect(result.stdout).toContain("tau attach - terminal TUI over a session protocol transport");
  });

  it("shows a clear error when diff-tool is launched outside a Tau diff review session", () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = spawnSync(process.execPath, [mainPath, "diff-tool"], {
      encoding: "utf8",
      env: {},
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "tau diff-tool must be launched with a Tau diff-review session environment.",
    );
    expect(result.stderr).toContain("missing TAU_DIFF_SOCKET");
    expect(result.stdout).toContain("tau diff-tool [--help]");
  });
});
