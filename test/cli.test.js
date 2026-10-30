import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../dist/core/cli.js";
import { spawnWithCapture } from "../dist/core/utils/spawn_capture.js";

describe("cli", () => {
  it("rejects unknown options", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow("unknown option: --bogus");
  });

  it("rejects the removed rpc subcommand", () => {
    expect(() => parseCliArgs(["rpc"])).toThrow("unexpected argument: rpc");
  });

  it("parses --no-client-tools", () => {
    const options = parseCliArgs(["--no-client-tools"]);
    expect(options.noClientTools).toBe(true);
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

  it("rejects invalid auth arguments before creating credential storage", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-auth-cli-home-"));
    try {
      const mainPath = resolve(process.cwd(), "dist/main.js");
      const result = await spawnWithCapture(
        process.execPath,
        [mainPath, "auth", "list", "--bogus"],
        {
          env: { ...process.env, HOME: home },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown auth list option "--bogus"');
      expect(existsSync(join(home, ".config", "tau"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects --debug in serve mode", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "serve", "--debug"], {
      env: process.env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--debug is only supported in TUI mode.");
    expect(result.stdout).toBe("");
  });

  it("rejects relative attach --new cwd before connecting", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(
      process.execPath,
      [mainPath, "attach", "--new", "--cwd", "relative/path", "ws://127.0.0.1:1"],
      {
        env: process.env,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--new requires --cwd <absolute-path>");
    expect(result.stdout).toContain("tau attach - terminal TUI over a session protocol transport");
  });
});
