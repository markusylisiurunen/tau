import { describe, expect, it } from "vitest";
import { getStartupPlatformError } from "../dist/core/platform_support.js";

describe("getStartupPlatformError", () => {
  it("returns an error for Windows", () => {
    expect(getStartupPlatformError("win32")).toContain("Windows is not supported");
  });

  it("allows macOS", () => {
    expect(getStartupPlatformError("darwin")).toBeUndefined();
  });

  it("allows Linux", () => {
    expect(getStartupPlatformError("linux")).toBeUndefined();
  });
});
