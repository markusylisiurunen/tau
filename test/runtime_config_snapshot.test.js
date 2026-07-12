import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfigFromToolBackend } from "../dist/core/config/runtime_config_snapshot.js";
import { createLocalToolExecutionBackend } from "../dist/core/index.js";

async function withTempHome(test) {
  const home = await mkdtemp(join(tmpdir(), "tau-runtime-config-"));
  try {
    await test(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("runtime config snapshot", () => {
  it("loads project config and content through a tool backend", async () => {
    await withTempHome(async (home) => {
      const repo = join(home, "repo");
      await mkdir(join(repo, ".tau", "personas"), { recursive: true });
      await writeFile(
        join(repo, ".tau", "config.json"),
        JSON.stringify({ defaultPersona: "project-persona:high" }),
        "utf8",
      );
      await writeFile(
        join(repo, ".tau", "personas", "project-persona.md"),
        [
          "---",
          "id: project-persona",
          "label: Project Persona",
          "provider: openai",
          "model: gpt-5.5",
          "---",
          "project system prompt",
        ].join("\n"),
        "utf8",
      );

      const runtime = await loadRuntimeConfigFromToolBackend({
        backend: createLocalToolExecutionBackend(),
        cwd: repo,
        home,
      });

      expect(runtime.config.defaultPersona).toBe("project-persona:high");
      expect(runtime.personas.find((persona) => persona.id === "project-persona")).toEqual(
        expect.objectContaining({
          label: "Project Persona",
          systemPrompt: "project system prompt",
        }),
      );
    });
  });
});
