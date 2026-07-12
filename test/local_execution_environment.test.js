import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(promptBootstrap.promptContext.nodeVersion).toBe(process.version);
    expect(runtimeContext.toolRegistry.schemas.length).toBeGreaterThan(0);
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
    });

    expect(environment.snapshot()).toEqual({
      kind: "local",
      cwd: "/repo",
      home: "/stored/home",
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
