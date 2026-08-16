import { describe, expect, it, vi } from "vitest";
import { ModelsCliError, runModelsCommand } from "../dist/core/models/cli.js";

describe("models cli", () => {
  it("reports a complete forced refresh", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const catalog = {
      refresh: vi.fn(async () => ({
        providers: new Map([
          ["openai", { status: "updated", modelCount: 10 }],
          ["anthropic", { status: "unchanged", modelCount: 5 }],
        ]),
        snapshot: new Map(),
      })),
    };
    try {
      await runModelsCommand(["refresh"], { catalog });
      expect(catalog.refresh).toHaveBeenCalledWith({ force: true });
      expect(log).toHaveBeenCalledWith(
        "model catalogs refreshed: 1 updated, 1 unchanged, 0 failed",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("keeps successful updates but fails the command on partial refresh", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const catalog = {
      refresh: vi.fn(async () => ({
        providers: new Map([
          ["openai", { status: "updated", modelCount: 10 }],
          ["anthropic", { status: "failed", error: new Error("timed out") }],
        ]),
        snapshot: new Map(),
      })),
    };
    try {
      await expect(runModelsCommand(["refresh"], { catalog })).rejects.toThrow(
        "failed providers:\n- anthropic: timed out",
      );
      expect(log).toHaveBeenCalledWith(
        "model catalogs refreshed: 1 updated, 0 unchanged, 1 failed",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("rejects unknown subcommands", async () => {
    await expect(runModelsCommand(["missing"])).rejects.toBeInstanceOf(ModelsCliError);
  });
});
