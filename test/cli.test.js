import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCliArgs, printHelp } from "../dist/core/cli.js";

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

  it("help output includes rpc subcommand", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printHelp([{ id: "demo-persona" }]);
      const output = logSpy.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      expect(output).toContain("tau rpc [options]");
      expect(output).toContain("tau async <command>");
      expect(output).toContain("rpc                           run headless stdio RPC mode");
      expect(output).toContain("async                         run async daemon/client commands.");
      expect(output).toContain("--caffeinated");
      expect(output).toContain("in RPC mode, stdin/stdout are reserved for protocol traffic.");
    } finally {
      logSpy.mockRestore();
    }
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
    expect(result.stdout).toContain("tau async cancel <id>");
  });
});
