import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";
import { describe, expect, it, vi } from "vitest";
import { createTauSdkClientWithHostConfig } from "../dist/sdk/local_client.js";

const localCreateInput = {
  executionEnvironment: { kind: "local", cwd: process.cwd() },
  attributes: { source: "test" },
};

async function withTempHome(test) {
  const home = await mkdtemp(join(tmpdir(), "tau-sdk-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await test(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

describe("sdk client integration", () => {
  it.each(["workspace-test:high", "missing:high"])(
    "resolves workspace default %s consistently at startup and on reapplication",
    async (defaultPersona) => {
      await withTempHome(async (home) => {
        const directory = join(home, ".tau", "personas");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "workspace-test.md"),
          `---
id: workspace-test
provider: openai
model: gpt-6.1-sol
reasoning: low
allowedReasoningLevels: [low]
---
Workspace persona.
`,
        );
        await writeFile(join(home, ".tau", "config.json"), JSON.stringify({ defaultPersona }));
        let expected;
        for (const runtimeOptions of [{}, { initialPersonaSelection: { personaId: null } }]) {
          const client = await createTauSdkClientWithHostConfig({ cwd: home }, {}, runtimeOptions);
          try {
            const session = await client.sessions.create({
              executionEnvironment: { kind: "local", cwd: home },
              attributes: { source: "test" },
            });
            const { settings, catalog } = await session.snapshot();
            if (!expected) {
              expected = { personaId: settings.personaId, reasoning: settings.reasoning };
              if (defaultPersona === "workspace-test:high") {
                expect(expected).toEqual({ personaId: "workspace-test", reasoning: "high" });
              } else {
                expect(settings.personaId).toBe(catalog.personas[0].id);
              }
            }
            expect(settings).toMatchObject(expected);
            await session.setPersona("workspace-test", { autoCompactThresholdTokens: 80000 });
            await session.setPersona(null);
            expect((await session.snapshot()).settings).toMatchObject({
              ...expected,
              autoCompactThresholdTokens: null,
            });
          } finally {
            await client.close();
          }
        }
      });
    },
    20000,
  );

  it("applies startup presets atomically and recovers session-owned settings independently", async () => {
    await withTempHome(async (home) => {
      const directory = join(home, ".tau", "personas");
      await mkdir(directory, { recursive: true });
      for (const [id, effort] of [
        ["workspace-test", "medium"],
        ["preset-test", "high"],
      ]) {
        await writeFile(
          join(directory, `${id}.md`),
          `---
id: ${id}
provider: openai
model: gpt-6.1-sol
reasoning: ${effort}
allowedReasoningLevels: [low, medium, high]
---
Test persona ${id}.
`,
        );
      }
      await writeFile(
        join(home, ".tau", "config.json"),
        JSON.stringify({ defaultPersona: "workspace-test:low" }),
      );
      const runtimeOptions = {
        autoCompactDefaults: { thresholdTokens: 128000 },
        initialPersonaSelection: {
          personaId: "preset-test",
          reasoning: "medium",
          autoCompactThresholdTokens: 80000,
        },
      };
      let client = await createTauSdkClientWithHostConfig({ cwd: home }, {}, runtimeOptions);
      try {
        let session = await client.sessions.create({
          executionEnvironment: { kind: "local", cwd: home },
          attributes: { source: "test" },
        });
        const id = session.id;
        expect((await session.snapshot()).settings).toMatchObject({
          personaId: "preset-test",
          reasoning: "medium",
          autoCompactThresholdTokens: 80000,
        });
        await session.setReasoning("low");
        await session.reload();
        expect((await session.snapshot()).settings.reasoning).toBe("low");
        const before = await session.snapshot();
        await expect(
          session.setPersona("workspace-test", { reasoning: "xhigh" }),
        ).rejects.toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("xhigh"),
        });
        await expect(session.setPersona("missing", { reasoning: "high" })).rejects.toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("missing"),
        });
        expect(await session.snapshot()).toEqual(before);
        await session.setPersona("preset-test");
        expect((await session.snapshot()).settings).toMatchObject({
          reasoning: "high",
          autoCompactThresholdTokens: null,
        });
        await session.setPersona(null);
        expect((await session.snapshot()).settings).toMatchObject({
          personaId: "workspace-test",
          reasoning: "low",
        });
        await session.setPersona("preset-test", {
          reasoning: "medium",
          autoCompactThresholdTokens: 90000,
        });
        await session.setReasoning("low");
        await client.close();
        client = await createTauSdkClientWithHostConfig(
          { cwd: home },
          {},
          {
            ...runtimeOptions,
            initialPersonaSelection: { personaId: "removed-preset-persona" },
          },
        );
        session = await client.sessions.observe(id);
        expect((await session.snapshot()).settings).toMatchObject({
          personaId: "preset-test",
          reasoning: "low",
          autoCompactThresholdTokens: 90000,
        });
        await expect(
          client.sessions.create({
            executionEnvironment: { kind: "local", cwd: home },
            attributes: { source: "test" },
          }),
        ).rejects.toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("removed-preset-persona"),
        });
      } finally {
        await client.close();
      }
    });
  }, 20000);

  it("creates, updates and resets the shared auto-compaction setting", async () => {
    await withTempHome(async (home) => {
      const client = await createTauSdkClient({ cwd: home });
      try {
        const session = await client.sessions.create({
          ...localCreateInput,
          autoCompactThresholdTokens: 50000,
        });
        const observer = await client.sessions.observe(session.id);
        const deltas = [];
        observer.onDelta((delta) => deltas.push(delta));
        let snapshot = await session.snapshot();
        expect(snapshot.settings.autoCompactThresholdTokens).toBe(50000);
        expect(snapshot.settings.effectiveAutoCompactThresholdTokens).toBe(
          Math.min(50000, snapshot.bootstrap.model.contextWindow - 16384),
        );
        await expect(session.setAutoCompactThreshold(49999)).rejects.toThrow();
        await session.setAutoCompactThreshold(75000);
        expect((await observer.snapshot()).settings.autoCompactThresholdTokens).toBe(75000);
        expect(
          deltas.some(
            (delta) =>
              delta.delta.type === "snapshot.patch" &&
              delta.delta.changes.some(
                (change) =>
                  change.type === "settings.set" &&
                  change.settings.autoCompactThresholdTokens === 75000,
              ),
          ),
        ).toBe(true);
        await session.setAutoCompactThreshold(null);
        snapshot = await observer.snapshot();
        expect(snapshot.settings.autoCompactThresholdTokens).toBeNull();
        expect(snapshot.settings.effectiveAutoCompactThresholdTokens).toBe(
          snapshot.bootstrap.model.contextWindow - 16384,
        );
      } finally {
        await client.close();
      }
    });
  });

  it("creates an in-process client and snapshots session state", async () => {
    await withTempHome(async (home) => {
      const client = await createTauSdkClient({
        cwd: home,
      });
      let unsubscribe = () => {};

      try {
        expect(client.ready.version).toBe(18);
        await expect(client.sessions.list()).resolves.toEqual([]);

        const session = await client.sessions.create(localCreateInput);
        unsubscribe = session.onDelta(() => {});
        const snapshot = await session.snapshot();
        expect(snapshot.sessionId).toBe(session.id);
        expect(snapshot.lifecycle).toBe("idle");
        expect(snapshot.messages.length).toBeGreaterThanOrEqual(1);
        expect(snapshot.messages[0].message.role).toBe("system");
      } finally {
        unsubscribe();
        await client.close();
      }
    });
  }, 20_000);

  it("leaves an injected remote catalog under caller refresh ownership", async () => {
    await withTempHome(async (home) => {
      const remoteModelCatalog = {
        refresh: vi.fn(async () => ({ providers: new Map(), snapshot: new Map() })),
        snapshot: vi.fn(() => new Map()),
      };
      const client = await createTauSdkClientWithHostConfig(
        { cwd: home },
        {},
        { remoteModelCatalog },
      );

      try {
        expect(remoteModelCatalog.refresh).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });
  });

  it("can disable its automatic remote catalog refresh", async () => {
    await withTempHome(async (home) => {
      const previousOffline = process.env.TAU_OFFLINE;
      delete process.env.TAU_OFFLINE;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      try {
        const client = await createTauSdkClient({ cwd: home, refreshModelCatalog: false });
        await client.close();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        if (previousOffline === undefined) delete process.env.TAU_OFFLINE;
        else process.env.TAU_OFFLINE = previousOffline;
      }
    });
  });

  it("cancels and awaits its owned remote catalog refresh on close", async () => {
    await withTempHome(async (home) => {
      const previousOffline = process.env.TAU_OFFLINE;
      delete process.env.TAU_OFFLINE;
      let markRequestStarted;
      let abortObserved = false;
      const requestStarted = new Promise((resolve) => {
        markRequestStarted = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (_url, request) =>
            await new Promise((_resolve, reject) => {
              markRequestStarted();
              const onAbort = () => {
                abortObserved = true;
                reject(request.signal.reason);
              };
              if (request.signal.aborted) onAbort();
              else request.signal.addEventListener("abort", onAbort, { once: true });
            }),
        ),
      );

      try {
        const client = await createTauSdkClient({ cwd: home });
        await requestStarted;
        await client.close();
        expect(abortObserved).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        if (previousOffline === undefined) delete process.env.TAU_OFFLINE;
        else process.env.TAU_OFFLINE = previousOffline;
      }
    });
  });

  it("persists sessions across in-process client restarts", async () => {
    await withTempHome(async (home) => {
      const firstClient = await createTauSdkClient({
        cwd: home,
      });
      const firstSession = await firstClient.sessions.create(localCreateInput);
      const firstSessionId = firstSession.id;
      await firstClient.close();

      const secondClient = await createTauSdkClient({
        cwd: home,
      });

      try {
        const restoredSession = await secondClient.sessions.observe(firstSessionId);
        await expect(restoredSession.snapshot()).resolves.toEqual(
          expect.objectContaining({
            sessionId: firstSessionId,
            lifecycle: "idle",
            messages: [
              expect.objectContaining({
                id: "system",
                message: expect.objectContaining({ role: "system" }),
              }),
            ],
          }),
        );
      } finally {
        await secondClient.close();
      }
    });
  }, 20_000);

  it("creates sessions with config and personas from the requested execution cwd", async () => {
    await withTempHome(async (home) => {
      const repo = join(home, "repo");
      await mkdir(join(repo, ".tau", "personas"), { recursive: true });
      await writeFile(
        join(repo, ".tau", "config.json"),
        JSON.stringify({ defaultPersona: "sdk-project-persona:high" }),
        "utf8",
      );
      await writeFile(
        join(repo, ".tau", "personas", "sdk-project-persona.md"),
        [
          "---",
          "id: sdk-project-persona",
          "label: SDK Project Persona",
          "provider: openai",
          "model: gpt-5.5",
          "---",
          "sdk project system prompt",
        ].join("\n"),
        "utf8",
      );

      const client = await createTauSdkClient({
        cwd: repo,
      });

      try {
        const session = await client.sessions.create({
          executionEnvironment: { kind: "local", cwd: repo },
          attributes: { source: "test" },
        });
        const snapshot = await session.snapshot();

        expect(snapshot.settings).toMatchObject({
          personaId: "sdk-project-persona",
          reasoning: "high",
        });
        expect(snapshot.catalog.personas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "sdk-project-persona", label: "SDK Project Persona" }),
          ]),
        );
        expect(snapshot.messages[0].message.content).toContain("sdk project system prompt");
      } finally {
        await client.close();
      }
    });
  }, 20_000);
});
