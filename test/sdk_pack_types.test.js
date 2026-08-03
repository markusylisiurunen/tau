import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd());
const tscPath = resolve(repoRoot, "node_modules", "typescript", "bin", "tsc");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

describe("sdk npm pack types", () => {
  it("publishes sdk declarations that compile in a consumer fixture", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tau-sdk-pack-types-"));

    try {
      const packDir = join(tempRoot, "pack");
      const npmCacheDir = join(tempRoot, "npm-cache");
      mkdirSync(packDir, { recursive: true });
      mkdirSync(npmCacheDir, { recursive: true });

      const packResult = run("npm", ["pack", "--json", "--pack-destination", packDir], {
        env: { ...process.env, npm_config_cache: npmCacheDir },
      });
      expect(packResult.status).toBe(0);

      const packOutput = JSON.parse(packResult.stdout);
      const packEntries = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
      expect(packEntries.length).toBeGreaterThan(0);
      const packageFilename = packEntries[0]?.filename;
      expect(typeof packageFilename).toBe("string");
      expect(packageFilename.length).toBeGreaterThan(0);
      const packedFiles = new Set(packEntries[0]?.files?.map((file) => file.path) ?? []);
      expect(packedFiles.size).toBeGreaterThan(0);
      expect(packedFiles.has("dist/core/modes/rpc_adapter.js")).toBe(false);
      expect(packedFiles.has("dist/sdk/errors.js")).toBe(false);
      expect(packedFiles.has("dist/sdk/stdio_transport.js")).toBe(false);
      expect(packedFiles.has("dist/sdk/stdio_transport.d.ts")).toBe(false);

      const tarballPath = join(packDir, packageFilename);
      const consumerDir = join(tempRoot, "consumer");
      const installedPackageDir = join(consumerDir, "node_modules", "@markusylisiurunen", "tau");
      mkdirSync(installedPackageDir, { recursive: true });

      const extractResult = run(
        "tar",
        ["-xzf", tarballPath, "-C", installedPackageDir, "--strip-components", "1", "package"],
        { cwd: consumerDir },
      );
      expect(extractResult.status).toBe(0);

      const piAiDir = join(consumerDir, "node_modules", "@earendil-works", "pi-ai");
      mkdirSync(piAiDir, { recursive: true });
      writeFileSync(
        join(piAiDir, "package.json"),
        `${JSON.stringify(
          {
            name: "@earendil-works/pi-ai",
            version: "0.0.0",
            types: "index.d.ts",
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(piAiDir, "index.d.ts"),
        [
          "export type TextContent = { type: 'text'; text: string };",
          "export type ThinkingContent = { type: 'thinking'; thinking: string };",
          "export type ToolCall = { type: 'tool-call'; id: string; name: string; input: unknown };",
          "export type Message = { role: string; content: unknown; api?: string; provider?: string; model?: string; stopReason?: string; usage?: unknown; timestamp?: number };",
          "export type AssistantMessage = Message & { role: 'assistant'; content: unknown[]; api: string; provider: string; model: string; stopReason: string; usage: unknown; timestamp: number };",
          "export type Tool = { name: string; description: string; parameters: Record<string, unknown> };",
          "",
        ].join("\n"),
      );

      const validFixturePath = join(consumerDir, "valid.ts");
      writeFileSync(
        validFixturePath,
        [
          'import type { SessionProtocolSnapshot, SessionProtocolTransport, TauSdkClient, TauSdkCreateSessionInput, TauSdkDelta, TauSdkInitializeParams, TauSdkRequestId, TauSdkSessionExecResult, TauSdkSessionSampleInput, TauSdkSessionSampleResult, TauSdkSessionSetReasoningResult, TauSdkReadyMessage, TauSdkTransportClientOptions, TauSdkUserTextProjection } from "@markusylisiurunen/tau/sdk";',
          'import { StdioSessionProtocolTransport, applySessionProtocolDelta, createTauSdkClient, createTauSdkClientFromTransport, createTauSdkWebSocketClient, getTauUserDisplayText, getTauUserModelText, projectTauUserText } from "@markusylisiurunen/tau/sdk";',
          "",
          "const sdkDelta: TauSdkDelta = {",
          "  version: 7,",
          '  type: "session.delta",',
          '  sessionId: "session-1",',
          "  fromRevision: 1,",
          "  toRevision: 2,",
          '  reason: "notice",',
          '  delta: { type: "snapshot.patch", changes: [{ type: "lifecycle.set", lifecycle: "idle" }] },',
          "};",
          "",
          "const sdkReady: TauSdkReadyMessage = {",
          "  version: 7,",
          '  type: "ready",',
          '  methods: ["initialize", "session.submit"],',
          "};",
          "",
          "const transportOptions: TauSdkTransportClientOptions = {",
          '  initialize: { client: { name: "fixture", version: "1" } },',
          "};",
          "",
          "declare const transport: SessionProtocolTransport;",
          "declare const spawnedProcess: ConstructorParameters<typeof StdioSessionProtocolTransport>[0];",
          "declare const client: TauSdkClient;",
          "const createInput: TauSdkCreateSessionInput = { executionEnvironment: { kind: 'local', cwd: '/repo' } };",
          "const initializeParams: TauSdkInitializeParams = { client: { name: 'fixture', version: '1' } };",
          "const requestId: TauSdkRequestId = 'req-1';",
          "declare const execResult: TauSdkSessionExecResult;",
          "const sampleInput: TauSdkSessionSampleInput = { context: { systemPrompt: 'system', messages: [] }, options: {} };",
          "declare const sampleResult: TauSdkSessionSampleResult;",
          "declare const setReasoningResult: TauSdkSessionSetReasoningResult;",
          "declare const snapshot: SessionProtocolSnapshot;",
          "const patchedSnapshot = applySessionProtocolDelta(snapshot, sdkDelta);",
          "const projectedUserText: TauSdkUserTextProjection = projectTauUserText('<system>hidden</system>\\nvisible');",
          "const displayText: string = getTauUserDisplayText('<system>hidden</system>\\nvisible');",
          "const modelText: string = getTauUserModelText('<system>hidden</system>\\nvisible');",
          "client.subscribe((delta) => { void delta.sessionId; });",
          "client.subscribeEphemeral((message) => { void message.sessionId; });",
          "transport.onFailure((error) => { void error.message; });",
          "void client.sessions.observe('session-1').then((session) => session.sample(sampleInput));",
          "void createTauSdkClient({ cwd: '/repo' });",
          "void createTauSdkClientFromTransport(transport, transportOptions);",
          'void createTauSdkWebSocketClient({ url: "ws://localhost:8787", authToken: "secret" });',
          "void new StdioSessionProtocolTransport(spawnedProcess);",
          "void createInput;",
          "void initializeParams;",
          "void requestId;",
          "void execResult;",
          "void sampleInput;",
          "void sampleResult;",
          "void setReasoningResult;",
          "void patchedSnapshot;",
          "void projectedUserText;",
          "void displayText;",
          "void modelText;",
          "void sdkDelta;",
          "void sdkReady;",
          "",
        ].join("\n"),
      );

      const invalidFixturePath = join(consumerDir, "invalid.ts");
      writeFileSync(
        invalidFixturePath,
        [
          'import type { TauSdkDelta, TauSdkReadyMessage } from "@markusylisiurunen/tau/sdk";',
          "",
          "const badDelta: TauSdkDelta = {",
          "  version: 1,",
          '  type: "session.delta",',
          '  sessionId: "session-1",',
          '  fromRevision: "1",',
          "  toRevision: 2,",
          '  reason: "unknown",',
          "  delta: {},",
          "};",
          "",
          "const badReady: TauSdkReadyMessage = {",
          "  version: 1,",
          '  type: "ready",',
          '  sessionId: "session-1",',
          '  methods: ["session.unknown"],',
          "};",
          "",
          "void badDelta;",
          "void badReady;",
          "",
        ].join("\n"),
      );

      const tscArgs = [
        tscPath,
        "--noEmit",
        "--strict",
        "--target",
        "ES2024",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--typeRoots",
        resolve(repoRoot, "node_modules", "@types"),
      ];

      const validCompileResult = run(process.execPath, [...tscArgs, validFixturePath], {
        cwd: consumerDir,
      });
      expect(validCompileResult.status).toBe(0);

      const invalidCompileResult = run(process.execPath, [...tscArgs, invalidFixturePath], {
        cwd: consumerDir,
      });
      expect(invalidCompileResult.status).not.toBe(0);
      expect(`${invalidCompileResult.stdout}\n${invalidCompileResult.stderr}`).toContain(
        "error TS",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
