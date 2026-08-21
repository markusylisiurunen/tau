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
      expect(packedFiles.has("dist/sdk/errors.js")).toBe(false);
      expect(packedFiles.has("dist/code_mode/index.d.ts")).toBe(true);
      expect(packedFiles.has("dist/core/static/code_mode/sandbox_runner.mjs")).toBe(true);
      expect(packedFiles.has("dist/core/static/tau_docs/index.md")).toBe(true);

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
          'import type { SessionProtocolFeedbackEvent, SessionProtocolFeedbackTone, SessionProtocolSnapshot, SessionProtocolTransport, TauSdkClient, TauSdkClientToolContext, TauSdkClientToolDescribeContext, TauSdkCreateSessionInput, TauSdkDelta, TauSdkInitializeParams, TauSdkReasoningEffort, TauSdkRequestId, TauSdkSessionExecResult, TauSdkSessionSampleInput, TauSdkSessionSampleResult, TauSdkSessionSetReasoningResult, TauSdkSessionTurnOutcome, TauSdkSessionTurnRecord, TauSdkReadyMessage, TauSdkTransportClientOptions, TauSdkUserTextProjection } from "@markusylisiurunen/tau/sdk";',
          'import { applySessionProtocolDelta, createTauSdkClient, createTauSdkClientFromTransport, createTauSdkWebSocketClient, getTauSdkSessionTurnOutcome, getTauSdkSessionTurnRecord, getTauUserDisplayText, getTauUserModelText, projectTauUserText, runTauClientToolCommand, truncateTauClientToolText } from "@markusylisiurunen/tau/sdk";',
          "",
          "const sdkDelta: TauSdkDelta = {",
          "  version: 13,",
          '  type: "session.delta",',
          '  sessionId: "session-1",',
          "  fromRevision: 1,",
          "  toRevision: 2,",
          '  cause: { type: "notice" },',
          '  delta: { type: "snapshot.patch", changes: [{ type: "lifecycle.set", lifecycle: "idle" }] },',
          "};",
          "",
          "const sdkReady: TauSdkReadyMessage = {",
          "  version: 13,",
          '  type: "ready",',
          '  methods: ["initialize", "session.submit"],',
          "};",
          "",
          "const transportOptions: TauSdkTransportClientOptions = {",
          '  initialize: { client: { name: "fixture", version: "1" } },',
          "};",
          "",
          "declare const transport: SessionProtocolTransport;",

          "declare const client: TauSdkClient;",
          "const createInput: TauSdkCreateSessionInput = { executionEnvironment: { kind: 'local', cwd: '/repo' }, attributes: { source: 'fixture' } };",
          "const initializeParams: TauSdkInitializeParams = { client: { name: 'fixture', version: '1' } };",
          "const requestId: TauSdkRequestId = 'req-1';",
          "const reasoning: TauSdkReasoningEffort = 'high';",
          "const feedbackTone: SessionProtocolFeedbackTone = 'default';",
          "const feedbackEvent: SessionProtocolFeedbackEvent = { type: 'feedback.notice', title: 'retrying', tone: feedbackTone, presentation: 'footer', durationMs: 3000 };",
          "declare const execResult: TauSdkSessionExecResult;",
          "declare const clientToolContext: TauSdkClientToolContext;",
          "declare const clientToolDescribeContext: TauSdkClientToolDescribeContext;",
          "void clientToolDescribeContext.signal;",
          "// @ts-expect-error describe context has no execution-environment authority",
          "void clientToolDescribeContext.executionEnvironment;",
          "void clientToolContext.agentId;",
          "void clientToolContext.executionEnvironment.exec('pwd');",
          "const clientToolPresentation = { subject: truncateTauClientToolText('subject') };",
          "void clientToolPresentation;",
          "void runTauClientToolCommand({ name: 'fixture', describe: () => ({ subject: 'subject' }), execute: async (_args, context) => (await context.executionEnvironment.exec('pwd')).output });",
          "void runTauClientToolCommand({ name: 'failure', execute: () => ({ ok: false, error: 'failed', presentation: { details: [] } }) });",
          "const sampleInput: TauSdkSessionSampleInput = { context: { systemPrompt: 'system', messages: [] }, options: {} };",
          "declare const sampleResult: TauSdkSessionSampleResult;",
          "declare const setReasoningResult: TauSdkSessionSetReasoningResult;",
          "declare const snapshot: SessionProtocolSnapshot;",
          "const turnRecord: TauSdkSessionTurnRecord | undefined = getTauSdkSessionTurnRecord(snapshot, 'turn-1');",
          "const turnOutcome: TauSdkSessionTurnOutcome | undefined = getTauSdkSessionTurnOutcome(snapshot, 'turn-1');",
          "const patchedSnapshot = applySessionProtocolDelta(snapshot, sdkDelta);",
          "const projectedUserText: TauSdkUserTextProjection = projectTauUserText('<system>hidden</system>\\nvisible');",
          "const displayText: string = getTauUserDisplayText('<system>hidden</system>\\nvisible');",
          "const modelText: string = getTauUserModelText('<system>hidden</system>\\nvisible');",
          "client.subscribe((delta) => { void delta.sessionId; });",
          "client.subscribeEphemeral((message) => { void message.sessionId; });",
          "transport.onFailure((error) => { void error.message; });",
          "void client.sessions.observe('session-1').then((session) => session.createEphemeralContext({ instructions: 'review', tools: ['bash'], reasoning }));",
          "void client.sessions.observe('session-1').then((session) => session.submitEphemeralThread({ contextId: 'context-1', threadId: 'thread-1', message: 'review', reasoning }));",
          "void client.sessions.observe('session-1').then((session) => session.sample(sampleInput));",
          "void createTauSdkClient({ cwd: '/repo', refreshModelCatalog: false });",
          "void createTauSdkClientFromTransport(transport, transportOptions);",
          'void createTauSdkWebSocketClient({ url: "ws://localhost:8787", authToken: "secret" });',

          "void createInput;",
          "void initializeParams;",
          "void requestId;",
          "void reasoning;",
          "void feedbackEvent;",
          "void execResult;",
          "void sampleInput;",
          "void sampleResult;",
          "void setReasoningResult;",
          "void turnRecord;",
          "void turnOutcome;",
          "void patchedSnapshot;",
          "void projectedUserText;",
          "void displayText;",
          "void modelText;",
          "void sdkDelta;",
          "void sdkReady;",
          "",
        ].join("\n"),
      );

      const codeModeFixturePath = join(consumerDir, "code-mode.ts");
      writeFileSync(
        codeModeFixturePath,
        [
          'import type { TauCodeModeApi, TauCodeModeFilesOptions, TauCodeModePersistOutput } from "@markusylisiurunen/tau/code-mode";',
          'import { buildTauCodeModeToolDescription, executeTauCodeMode, runTauCodeModeCommand, truncateTauClientToolText } from "@markusylisiurunen/tau/code-mode";',
          'import { createTauCodeModeClientTool } from "@markusylisiurunen/tau/sdk";',
          "",
          "const api: TauCodeModeApi = { echo: async ([value], context) => ({ value, invocation: context.invocation }) };",
          "const persistOutput: TauCodeModePersistOutput = async (output) => output.contextTruncated ? { path: '/tmp/output' } : undefined;",
          "const definition = { name: 'fixture', documentation: '# Fixture API', api, persistOutput };",
          "const description = buildTauCodeModeToolDescription({ name: 'fixture', description: 'Use the fixture API.' });",
          "const tool = createTauCodeModeClientTool({ ...definition, description });",
          "declare const files: TauCodeModeFilesOptions;",
          "void executeTauCodeMode({ ...definition, code: 'console.log(await fixture.echo(1))', files });",
          "void runTauCodeModeCommand(definition);",
          "void truncateTauClientToolText('detail', { maxLines: 1, maxLineChars: 128 });",
          "void tool;",
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

      const codeModeCompileResult = run(process.execPath, [...tscArgs, codeModeFixturePath], {
        cwd: consumerDir,
      });
      expect(codeModeCompileResult.status).toBe(0);

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
