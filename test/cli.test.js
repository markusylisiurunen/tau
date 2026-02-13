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

  it("help output includes rpc subcommand", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printHelp([{ id: "demo-persona" }]);
      const output = logSpy.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      expect(output).toContain("tau rpc [options]");
      expect(output).toContain("rpc                           run headless stdio RPC mode");
      expect(output).toContain("in RPC mode, stdin/stdout are reserved for protocol traffic.");
    } finally {
      logSpy.mockRestore();
    }
  });
});
