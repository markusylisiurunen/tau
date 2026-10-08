import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../dist/core/cli.js";
import { spawnWithCapture } from "../dist/core/utils/spawn_capture.js";

describe.concurrent("cli", () => {
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

  it("uses runtime prompt bootstrap for debug project context", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tau-debug-context-home-")));
    let current = home;
    let atLimit;
    let beyondLimit;
    try {
      const personaDirectory = join(home, ".tau", "personas");
      mkdirSync(personaDirectory, { recursive: true });
      writeFileSync(
        join(personaDirectory, "debug-context.md"),
        [
          "---",
          "id: debug-context",
          "provider: openai",
          "model: gpt-5.5",
          "tools: []",
          "---",
          "debug context prompt",
        ].join("\n"),
      );
      for (let depth = 1; depth <= 17; depth += 1) {
        current = join(current, `level-${depth}`);
        mkdirSync(current, { recursive: true });
        if (depth === 16) {
          atLimit = join(current, "AGENTS.md");
          writeFileSync(atLimit, "at limit");
        }
        if (depth === 17) {
          beyondLimit = join(current, "AGENTS.md");
          writeFileSync(beyondLimit, "beyond limit");
        }
      }

      const mainPath = resolve(process.cwd(), "dist/main.js");
      const result = await spawnWithCapture(
        process.execPath,
        [mainPath, "--debug", "--persona", "debug-context"],
        {
          cwd: home,
          env: { ...process.env, HOME: home },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(atLimit);
      expect(result.stdout).not.toContain(beyondLimit);
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

  it("prints telegram help text when telegram command parsing fails", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "telegram"], {
      env: process.env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing --config-file <path>");
    expect(result.stderr).toContain("\n\n");
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).toContain("tau telegram --config-file <path>");
  });

  it("prints models help", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "models", "--help"], {
      env: process.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tau models refresh");
    expect(result.stderr).toBe("");
  });

  it("prints pdf-unpack help", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(
      process.execPath,
      [mainPath, "tool", "pdf-unpack", "--help"],
      {
        env: process.env,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tau tool pdf-unpack <file.pdf>");
    expect(result.stdout).toContain("requires pdftoppm from Poppler on PATH");
    expect(result.stderr).toBe("");
  });

  it("prints tool help text when tool command parsing fails", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "tool", "missing"], {
      env: process.env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown tool subcommand 'missing'");
    expect(result.stdout).toContain("tau tool <command>");
  });

  it("prints diff-tool help", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "diff-tool", "--help"], {
      env: process.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tau diff-tool [--help]");
    expect(result.stdout).toContain("built-in browser diff review tool");
    expect(result.stderr).toBe("");
  });

  it("rejects the removed command attachment form", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "attach", "--", "true"], {
      env: process.env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown attach option: --");
    expect(result.stdout).toContain("tau attach - terminal TUI over a session protocol transport");
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

  it("shows a clear error when diff-tool is launched outside a Tau diff review session", async () => {
    const mainPath = resolve(process.cwd(), "dist/main.js");
    const result = await spawnWithCapture(process.execPath, [mainPath, "diff-tool"], {
      env: {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "tau diff-tool must be launched with a Tau diff-review session environment.",
    );
    expect(result.stderr).toContain("missing TAU_DIFF_SOCKET");
    expect(result.stdout).toContain("tau diff-tool [--help]");
  });
});
