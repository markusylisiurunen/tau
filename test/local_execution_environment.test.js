import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalToolExecutionBackend, ToolCatalog } from "../dist/core/index.js";
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

  it("resolves runtime bootstrap from local execution context", () => {
    const toolBackend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(toolBackend);
    const environment = new LocalExecutionEnvironment({
      cwd: "/repo",
      home: "/home/user",
      readFile: () => {
        throw new Error("readFile should not be called when agent context is disabled");
      },
      toolBackend,
      toolRegistry,
    });

    const runtimeContext = environment.resolveRuntimeContext({
      persona: personas[0],
      discoveredSkills: [],
      includeAgentContext: false,
    });

    const { promptBootstrap } = runtimeContext;
    expect(promptBootstrap.promptContext.cwd).toBe("/repo");
    expect(promptBootstrap.promptContext.home).toBe("/home/user");
    expect(promptBootstrap.promptContext.includeAgentContext).toBe(false);
    expect(runtimeContext.toolRegistry).toBe(toolRegistry);
    expect(environment.snapshot()).toEqual({
      kind: "local",
      cwd: "/repo",
      home: "/home/user",
    });
  });

  it("restores persisted local execution home", async () => {
    const resolver = new LocalExecutionEnvironmentResolver({
      home: "/host/home",
      readFile: () => {
        throw new Error("readFile should not be called while restoring the snapshot");
      },
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
      await mkdir(repo, { recursive: true });
      await writeFile(join(storedHome, ".config", "tau", "config.json"), "{}", "utf8");
      const resolver = new LocalExecutionEnvironmentResolver({
        home: "/host/home",
        readFile: () => {
          throw new Error("readFile should not be called while resolving runtime config");
        },
        toolBackend: createLocalToolExecutionBackend(),
      });

      const environment = await resolver.restore({
        kind: "local",
        cwd: repo,
        home: storedHome,
      });
      const runtime = await environment.resolveRuntimeConfig();

      expect(runtime.bootstrap.levels[0].levelRoot).toBe(storedHome);
    } finally {
      await rm(storedHome, { recursive: true, force: true });
    }
  });
});
