import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalToolExecutionBackend } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import {
  LocalExecutionEnvironment,
  LocalExecutionEnvironmentResolver,
} from "../dist/execution/local_execution_environment.js";

describe("LocalExecutionEnvironment", () => {
  it("captures bash stdout and stderr separately plus interleaved output", async () => {
    const backend = createLocalToolExecutionBackend();

    const result = await backend.runBash(
      "node -e \"process.stdout.write('stdout-line\\\\n'); process.stderr.write('stderr-line\\\\n')\"",
    );

    expect(result.stdout).toBe("stdout-line\n");
    expect(result.stderr).toBe("stderr-line\n");
    expect(result.output).toContain("stdout-line\n");
    expect(result.output).toContain("stderr-line\n");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("runs Bash syntax through the execution environment login profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-local-bash-home-"));
    const repo = join(home, "repo");
    await mkdir(repo);
    await writeFile(join(home, ".bash_profile"), "export TAU_LOGIN_PROFILE=loaded\n", "utf8");
    const bashEnv = join(home, "bash-env");
    await writeFile(bashEnv, "export TAU_BASH_ENV=loaded\n", "utf8");
    const environment = new LocalExecutionEnvironment({
      cwd: repo,
      home,
      env: { BASH_ENV: bashEnv },
      backend: createLocalToolExecutionBackend(),
    });

    try {
      const result = await environment
        .getToolExecutionBackend()
        .runBash(
          'values=(one two); printf "%s|%s|%s|%s" "$TAU_LOGIN_PROFILE" "$TAU_BASH_ENV" "$HOME" "$PWD"',
          { env: { HOME: "/tmp/overridden-home" } },
        );

      expect(result.stdout).toBe(`loaded|loaded|${home}|${await realpath(repo)}`);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resolves Node helpers from the login profile PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-local-node-home-"));
    const repo = join(home, "repo");
    const bin = join(home, "bin");
    await mkdir(repo);
    await mkdir(bin);
    await writeFile(join(home, ".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n', "utf8");
    await writeFile(join(bin, "node"), '#!/usr/bin/env bash\nprintf "profile-node"\n', "utf8");
    await chmod(join(bin, "node"), 0o755);
    const environment = new LocalExecutionEnvironment({
      cwd: repo,
      home,
      backend: createLocalToolExecutionBackend(),
    });

    try {
      const result = await environment
        .getToolExecutionBackend()
        .runNodeScript('process.stdout.write("base-node")');

      expect(result.stdout).toBe("profile-node");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("spawns login Bash without changing execution controls", async () => {
    const calls = [];
    const signal = new AbortController().signal;
    const backend = createLocalToolExecutionBackend({
      spawn: async (command, args, options) => {
        calls.push({ command, args, options });
        return {
          stdout: "",
          stderr: "",
          output: "",
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      },
      env: {
        cwd: () => "/repo",
        home: () => "/home/user",
        platform: () => process.platform,
        env: () => ({ PATH: process.env.PATH }),
      },
    });

    await backend.runBash("echo $VALUE", {
      cwd: "subdir",
      timeoutMs: 1234,
      signal,
      env: { VALUE: "set", NO_COLOR: "0", TERM: "xterm-256color", PAGER: "less" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "bash",
      args: ["-lc", "echo $VALUE"],
      options: {
        cwd: "/repo/subdir",
        detached: true,
        killProcessGroup: true,
        signal,
        timeoutMs: 1234,
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    expect(calls[0].options.env).toMatchObject({
      VALUE: "set",
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("scopes explicit environment variables without filtering sensitive names", async () => {
    const cwd = process.cwd();
    const environment = new LocalExecutionEnvironment({
      cwd,
      home: process.env.HOME ?? cwd,
      env: {
        GH_CONFIG_DIR: "/srv/cowork/gh",
        SESSION_TOKEN: "session-secret",
      },
      backend: createLocalToolExecutionBackend({
        env: {
          cwd: () => cwd,
          home: () => cwd,
          platform: () => process.platform,
          env: () => ({
            PATH: process.env.PATH,
            HOST_TOKEN: "host-secret",
            VISIBLE_HOST_VALUE: "visible",
          }),
        },
      }),
    });

    const result = await environment
      .getToolExecutionBackend()
      .runBash(
        `node -e 'process.stdout.write([process.env.HOST_TOKEN ?? "unset", process.env.SESSION_TOKEN, process.env.VISIBLE_HOST_VALUE].join("|"))'`,
      );

    expect(result.stdout).toBe("unset|session-secret|visible");
    expect(environment.snapshot()).toEqual({
      kind: "local",
      cwd,
      home: process.env.HOME ?? cwd,
      env: {
        GH_CONFIG_DIR: "/srv/cowork/gh",
        SESSION_TOKEN: "session-secret",
      },
    });
  });

  it("resolves runtime bootstrap through the local execution backend", async () => {
    const cwd = process.cwd();
    const environment = new LocalExecutionEnvironment({
      cwd,
      home: process.env.HOME ?? cwd,
      backend: createLocalToolExecutionBackend(),
    });

    const runtimeContext = await environment.resolveRuntimeContext({
      cwd,
      persona: personas[0],
      discoveredSkills: [],
      includeAgentContext: false,
      agentContextFiles: [],
    });

    const { promptBootstrap } = runtimeContext;
    expect(promptBootstrap.promptContext.cwd).toBe(cwd);
    expect(promptBootstrap.promptContext.home).toBe(process.env.HOME ?? cwd);
    expect(promptBootstrap.promptContext.includeAgentContext).toBe(false);
    expect(promptBootstrap.promptContext.platform).toBe(process.platform);
    expect(environment.snapshot()).toEqual({
      kind: "local",
      cwd,
      home: process.env.HOME ?? cwd,
    });
  });

  it("loads prompt context larger than the tool output preview budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-local-env-context-"));
    try {
      const repo = join(home, "repo");
      await mkdir(repo, { recursive: true });
      const largeAgents = `large context marker\n${"x".repeat(1_100_000)}`;
      await writeFile(join(repo, "AGENTS.md"), largeAgents, "utf8");
      const environment = new LocalExecutionEnvironment({
        cwd: repo,
        home,
        backend: createLocalToolExecutionBackend(),
      });

      const runtimeContext = await environment.resolveRuntimeContext({
        cwd: repo,
        persona: personas[0],
        discoveredSkills: [],
        includeAgentContext: true,
        agentContextFiles: [],
      });

      expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
        largeAgents,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("restores persisted local execution home", async () => {
    const resolver = new LocalExecutionEnvironmentResolver({
      home: "/host/home",
      toolBackend: createLocalToolExecutionBackend(),
    });

    const environment = await resolver.restore({
      kind: "local",
      cwd: "/repo",
      home: "/stored/home",
      env: { GH_CONFIG_DIR: "/stored/gh" },
    });

    expect(environment.snapshot()).toEqual({
      kind: "local",
      cwd: "/repo",
      home: "/stored/home",
      env: { GH_CONFIG_DIR: "/stored/gh" },
    });
  });

  it("loads runtime config through the persisted local execution home", async () => {
    const storedHome = await mkdtemp(join(tmpdir(), "tau-local-env-home-"));
    try {
      const repo = join(storedHome, "repo");
      await mkdir(join(storedHome, ".config", "tau"), { recursive: true });
      await mkdir(join(repo, ".tau", "prompts"), { recursive: true });
      await writeFile(join(storedHome, ".config", "tau", "config.json"), "{}", "utf8");
      const largePrompt = "x".repeat(1_100_000);
      await writeFile(
        join(repo, ".tau", "prompts", "large.md"),
        `---\nid: large\n---\n${largePrompt}`,
        "utf8",
      );
      const resolver = new LocalExecutionEnvironmentResolver({
        home: "/host/home",
        toolBackend: createLocalToolExecutionBackend(),
      });

      const environment = await resolver.restore({
        kind: "local",
        cwd: repo,
        home: storedHome,
      });
      const runtime = await environment.resolveRuntimeConfig(repo);

      expect(runtime.bootstrap.levels[0].levelRoot).toBe(storedHome);
      expect(runtime.prompts.find((prompt) => prompt.id === "large")?.template).toBe(largePrompt);
    } finally {
      await rm(storedHome, { recursive: true, force: true });
    }
  });
});
