import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadClientConfig,
  loadHostConfig,
  loadSessionConfig,
} from "../dist/core/config/ownership.js";
import { loadRuntimeConfig } from "../dist/core/config/runtime.js";
import { resolveSessionBootstrap } from "../dist/host/session_bootstrap.js";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "tau-session-bootstrap-"));
  const home = join(root, "home");
  const write = (directory, config) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  };
  const deps = (cwd) => ({
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: { getEnv: () => ({}), cwd: () => cwd, home: () => home },
  });
  const environment = (cwd) => ({
    snapshot: () => ({ kind: "local", cwd, home }),
    resolveRuntimeConfig: (target, options) => loadRuntimeConfig(target, deps(target), options),
  });
  return { root, home, write, deps, environment, cleanup: () => rmSync(root, { recursive: true }) };
}

const server = (command) => ({ type: "stdio", command });

function writeConflictingProjects(fx) {
  const daemon = join(fx.home, "daemon");
  const project = join(fx.home, "project");
  fx.write(join(fx.home, ".config", "tau"), {
    apiKeys: { openai: "global-key" },
    speech: { vocabulary: ["Personal"], voiceId: "global-voice" },
    mcpServers: { shared: server("global-server") },
    history: { endpoint: "https://history.example.com", apiKey: "history-key" },
  });
  fx.write(join(daemon, ".tau"), {
    speech: { vocabulary: ["Daemon"], voiceId: "daemon-voice" },
    mcpServers: { daemon: server("daemon-server") },
  });
  fx.write(join(project, ".tau"), {
    speech: { vocabulary: ["Project"] },
    mcpServers: { project: server("project-server") },
  });
  return { daemon, project };
}

async function bootstrap(fx, cwd, options = {}) {
  return await resolveSessionBootstrap({
    executionEnvironment: fx.environment(cwd),
    remoteCatalog: new Map(),
    recovering: false,
    hostApiKeys: { openai: "host-key" },
    ...options,
  });
}

describe("config ownership", () => {
  it("gives each process only the settings it owns", () => {
    const fx = createFixture();
    try {
      const { daemon } = writeConflictingProjects(fx);
      const deps = fx.deps(daemon);

      const host = loadHostConfig(daemon, deps);
      expect(Object.keys(host).sort()).toEqual(["apiKeys", "history"]);

      const client = loadClientConfig(daemon, deps);
      expect(client).not.toHaveProperty("mcpServers");
      expect(client).not.toHaveProperty("history");
      expect(client.apiKeys).toEqual({ openai: "global-key" });
      expect(client.speech).toEqual({
        voiceId: "daemon-voice",
        personalVocabulary: ["Personal"],
      });

      const session = loadSessionConfig(daemon, deps);
      expect(session).not.toHaveProperty("apiKeys");
      expect(session).not.toHaveProperty("history");
      expect(session).not.toHaveProperty("speech");
      expect(Object.keys(session.mcpServers).sort()).toEqual(["daemon", "shared"]);
      expect(session.speechVocabulary).toEqual(["Daemon", "Personal"]);
    } finally {
      fx.cleanup();
    }
  });

  it("keeps the global level out of directories outside home", () => {
    const fx = createFixture();
    try {
      writeConflictingProjects(fx);
      const outside = join(fx.root, "srv");
      fx.write(join(outside, ".tau"), { speech: { vocabulary: ["Outside"] } });
      const deps = fx.deps(outside);

      expect(loadClientConfig(outside, deps).speech.personalVocabulary).toEqual([]);
      expect(loadSessionConfig(outside, deps)).toMatchObject({
        mcpServers: {},
        speechVocabulary: ["Outside"],
      });
    } finally {
      fx.cleanup();
    }
  });
});

describe("resolveSessionBootstrap", () => {
  it("takes session settings from the session's directory and credentials from the host", async () => {
    const fx = createFixture();
    try {
      const { project } = writeConflictingProjects(fx);
      const { config } = await bootstrap(fx, project);

      expect(Object.keys(config.mcpServers).sort()).toEqual(["project", "shared"]);
      expect(config.speechVocabulary).toEqual(["Project", "Personal"]);
      expect(config.apiKeys).toEqual({ openai: "host-key" });
      expect(config).not.toHaveProperty("history");
    } finally {
      fx.cleanup();
    }
  });

  it("never takes credentials from configuration on the target", async () => {
    const fx = createFixture();
    try {
      const { project } = writeConflictingProjects(fx);
      const { config } = await bootstrap(fx, project, { hostApiKeys: undefined });
      expect(config.apiKeys).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain("global-key");
    } finally {
      fx.cleanup();
    }
  });

  it("applies explicit persona requests and rejects unavailable ones", async () => {
    const fx = createFixture();
    try {
      const { project } = writeConflictingProjects(fx);
      const defaults = await bootstrap(fx, project);
      const other = defaults.personas.find((persona) => persona.id !== defaults.persona.id);

      const requested = await bootstrap(fx, project, {
        personaRequest: { persona: `${other.id}:low`, reasoning: "high" },
      });
      expect(requested.persona.id).toBe(other.id);
      expect(requested.persona.settings.reasoning).toBe("high");

      const selected = await bootstrap(fx, project, {
        personaRequest: {
          selection: { personaId: other.id, autoCompactThresholdTokens: 50_000 },
        },
      });
      expect(selected.persona.id).toBe(other.id);
      expect(selected.initialAutoCompactThresholdTokens).toBe(50_000);

      await expect(
        bootstrap(fx, project, { personaRequest: { persona: "missing-persona" } }),
      ).rejects.toThrow();
    } finally {
      fx.cleanup();
    }
  });

  it("ignores explicit persona requests while recovering", async () => {
    const fx = createFixture();
    try {
      const { project } = writeConflictingProjects(fx);
      const defaults = await bootstrap(fx, project);
      const recovered = await bootstrap(fx, project, {
        recovering: true,
        personaRequest: { persona: "missing-persona" },
      });
      expect(recovered.persona.id).toBe(defaults.persona.id);
    } finally {
      fx.cleanup();
    }
  });
});
