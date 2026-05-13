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
      mkdirSync(packDir, { recursive: true });

      const packResult = run("npm", ["pack", "--json", "--pack-destination", packDir]);
      expect(packResult.status).toBe(0);

      const packEntries = JSON.parse(packResult.stdout);
      expect(Array.isArray(packEntries)).toBe(true);
      expect(packEntries.length).toBeGreaterThan(0);
      const packageFilename = packEntries[0]?.filename;
      expect(typeof packageFilename).toBe("string");
      expect(packageFilename.length).toBeGreaterThan(0);

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
        "export type Message = { role: string; content: unknown };\n",
      );

      const validFixturePath = join(consumerDir, "valid.ts");
      writeFileSync(
        validFixturePath,
        [
          'import type { TauSdkEvent, TauSdkReadyMessage } from "@markusylisiurunen/tau/sdk";',
          "",
          "const sdkEvent: TauSdkEvent = {",
          "  version: 1,",
          '  type: "event",',
          "  event: {",
          "    version: 1,",
          '    event: { type: "notice" },',
          "  },",
          "};",
          "",
          "const sdkReady: TauSdkReadyMessage = {",
          "  version: 1,",
          '  type: "ready",',
          '  sessionId: "session-1",',
          '  methods: ["initialize", "session.submit"],',
          "  coreEventVersion: 1,",
          "};",
          "",
          "void sdkEvent;",
          "void sdkReady;",
          "",
        ].join("\n"),
      );

      const invalidFixturePath = join(consumerDir, "invalid.ts");
      writeFileSync(
        invalidFixturePath,
        [
          'import type { TauSdkEvent, TauSdkReadyMessage } from "@markusylisiurunen/tau/sdk";',
          "",
          "const badEvent: TauSdkEvent = {",
          "  version: 2,",
          '  type: "event",',
          "  event: {",
          '    version: "1",',
          "    event: {},",
          "  },",
          "};",
          "",
          "const badReady: TauSdkReadyMessage = {",
          "  version: 1,",
          '  type: "ready",',
          '  sessionId: "session-1",',
          '  methods: ["session.unknown"],',
          '  coreEventVersion: "1",',
          "};",
          "",
          "void badEvent;",
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
