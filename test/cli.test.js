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
});
