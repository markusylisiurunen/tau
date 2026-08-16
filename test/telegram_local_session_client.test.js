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
import { describe, expect, it, vi } from "vitest";
import { createCommandClientTools } from "../dist/core/client_tools/command_client_tools.js";
import { createLocalTelegramSessionClient } from "../dist/core/telegram/local_session_client.js";

function createConfigDeps(home) {
  return {
    fs: {
      readFile: (path) => readFileSync(path, "utf8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => ({}),
      cwd: () => home,
      home: () => home,
    },
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("local Telegram session client", () => {
  it("advertises command tools selected by each workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-telegram-client-home-"));
    const defaultWorkspace = join(home, "default-workspace");
    const selectedWorkspace = join(home, "selected-workspace");
    const disabledWorkspace = join(home, "disabled-workspace");
    const globalConfigDirectory = join(home, ".config", "tau");
    const client = { sessions: {}, close: vi.fn(async () => {}) };
    const createSdkClient = vi.fn(async () => client);
    const buildCommandClientTools = vi.fn(createCommandClientTools);
    const hostConfig = { history: { endpoint: "https://history.example.com" } };
    const remoteModelCatalog = { snapshot: vi.fn(() => new Map()) };

    try {
      mkdirSync(globalConfigDirectory, { recursive: true });
      mkdirSync(defaultWorkspace, { recursive: true });
      mkdirSync(join(selectedWorkspace, ".tau"), { recursive: true });
      mkdirSync(join(disabledWorkspace, ".tau"), { recursive: true });
      writeJson(join(globalConfigDirectory, "config.json"), {
        clientTools: [
          {
            name: "notify",
            defaultEnabled: true,
            description: "Show a notification.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            command: "./tools/notify",
          },
          {
            name: "deploy",
            defaultEnabled: false,
            description: "Deploy the project.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            command: "./tools/deploy",
          },
        ],
      });
      writeJson(join(selectedWorkspace, ".tau", "config.json"), {
        enabledClientTools: ["deploy"],
      });
      writeJson(join(disabledWorkspace, ".tau", "config.json"), {
        enabledClientTools: [],
      });

      const configDeps = createConfigDeps(home);
      for (const cwd of [defaultWorkspace, selectedWorkspace, disabledWorkspace]) {
        await createLocalTelegramSessionClient({
          client: { cwd, persona: "gpt-5.6-sol-coder", noAgentContextFiles: true },
          hostConfig,
          configDeps,
          remoteModelCatalog,
          deps: {
            createCommandClientTools: buildCommandClientTools,
            createSdkClient,
          },
        });
      }

      expect(
        buildCommandClientTools.mock.calls.map(([configs]) => configs.map(({ name }) => name)),
      ).toEqual([["notify"], ["deploy"], []]);
      expect(buildCommandClientTools.mock.calls[0][0][0].command).toBe(
        join(home, "tools", "notify"),
      );
      expect(buildCommandClientTools.mock.calls[1][0][0].command).toBe(
        join(home, "tools", "deploy"),
      );
      expect(createSdkClient).toHaveBeenCalledTimes(3);
      expect(createSdkClient.mock.calls[1][0]).toMatchObject({
        cwd: selectedWorkspace,
        persona: "gpt-5.6-sol-coder",
        noAgentContextFiles: true,
        initialize: { client: { name: "tau-telegram", version: "1" } },
      });
      expect(createSdkClient.mock.calls[1][0].clientTools.map((tool) => tool.schema.name)).toEqual([
        "deploy",
      ]);
      expect(createSdkClient.mock.calls[1][1]).toBe(hostConfig);
      expect(createSdkClient.mock.calls.map((call) => call[2])).toEqual([
        { remoteModelCatalog },
        { remoteModelCatalog },
        { remoteModelCatalog },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
