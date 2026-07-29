import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getExaApiKey } from "../dist/core/config/index.js";
import { createWebToolDefinition } from "../dist/core/tools/web.js";

function createExecutionResult(output, exitCode = 0) {
  return {
    output,
    stdout: output,
    stderr: "",
    exitCode,
    truncated: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
  };
}

function createBackend() {
  return {
    runNodeScript: vi.fn(async () =>
      createExecutionResult(JSON.stringify({ runnerPath: "/tmp/tau-web/runner.mjs" })),
    ),
    runBash: vi.fn(async () => createExecutionResult("program output\n")),
    writeFile: vi.fn(),
  };
}

async function runTool(tool, arguments_, context = { scope: "subagent", cwd: "/project" }) {
  const dispatch = await tool.dispatch(
    { id: "web-1", name: "web", arguments: arguments_ },
    new AbortController().signal,
    context,
  );
  return { dispatch, result: await dispatch.run };
}

function getToolText(result) {
  return result.toolResult.content.find((block) => block.type === "text")?.text ?? "";
}

function runRunner(runnerPath, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("Exa web code-mode tool", () => {
  it("resolves the Exa API key from the environment before config", () => {
    expect(getExaApiKey({ apiKeys: { exa: "config-key" } }, { EXA_API_KEY: " env-key " })).toBe(
      "env-key",
    );
    expect(getExaApiKey({ apiKeys: { exa: " config-key " } }, {})).toBe("config-key");
  });

  it("prepares its runtime once and returns console output", async () => {
    const backend = createBackend();
    const tool = createWebToolDefinition({ apiKeys: { exa: "exa-key" } }, backend);

    const first = await runTool(tool, { code: "console.log(docs)" });
    const second = await runTool(tool, { code: "console.log('again')" });

    expect(first.dispatch.startedUiEvent).toMatchObject({
      type: "code_mode_started",
      toolName: "web",
      label: "web",
    });
    expect(getToolText(first.result)).toBe("program output");
    expect(first.result.uiEvent).toMatchObject({
      type: "code_mode_finished",
      toolName: "web",
      status: "success",
    });
    expect(getToolText(second.result)).toBe("program output");
    expect(backend.runNodeScript).toHaveBeenCalledTimes(1);
    expect(backend.runBash).toHaveBeenCalledTimes(2);

    const executionOptions = backend.runBash.mock.calls[0][1];
    expect(backend.runBash.mock.calls[0][0]).toBe('exec "$0" "$@"');
    expect(executionOptions.args).toEqual(["node", "/tmp/tau-web/runner.mjs"]);
    expect(JSON.parse(executionOptions.stdin.toString("utf8"))).toEqual({
      apiKey: "exa-key",
      code: "console.log(docs)",
      cwd: "/project",
    });
  });

  it("fails before preparation when the Exa API key is missing", async () => {
    const backend = createBackend();
    const tool = createWebToolDefinition({}, backend);
    const { result } = await runTool(tool, { code: "console.log(docs)" });

    expect(result.toolResult.isError).toBe(true);
    expect(getToolText(result)).toContain("Missing Exa API key.");
    expect(backend.runNodeScript).not.toHaveBeenCalled();
    expect(backend.runBash).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments", async () => {
    const backend = createBackend();
    const tool = createWebToolDefinition({ apiKeys: { exa: "exa-key" } }, backend);
    const { result } = await runTool(tool, {
      code: "console.log(docs)",
      objective: "legacy shape",
    });

    expect(result.toolResult.isError).toBe(true);
    expect(getToolText(result)).toContain("Invalid arguments");
    expect(backend.runNodeScript).not.toHaveBeenCalled();
  });

  it("runs generated code with the SDK bridge and console output semantics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-web-runner-test-"));
    try {
      const sourceRunner = join(
        process.cwd(),
        "src",
        "core",
        "static",
        "code_mode",
        "web",
        "runner.mjs",
      );
      const runnerPath = join(directory, "runner.mjs");
      writeFileSync(runnerPath, readFileSync(sourceRunner, "utf8"));
      writeFileSync(join(directory, "documentation.md"), "# Exa runtime documentation\n");
      const packageDirectory = join(directory, "node_modules", "exa-js");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: "exa-js", type: "module", exports: "./index.mjs" }),
      );
      writeFileSync(
        join(packageDirectory, "index.mjs"),
        [
          "export default class Exa {",
          "  constructor(apiKey) { this.apiKey = apiKey; }",
          "  async search(query, options) {",
          "    return { query, options, authenticated: this.apiKey === 'exa-key' };",
          "  }",
          "  async getContents(urls, options) { return { urls, options }; }",
          "}",
        ].join("\n"),
      );

      const result = await runRunner(runnerPath, {
        apiKey: "exa-key",
        code: [
          "console.log(docs.trim());",
          "const result = await exa.search('tau', { numResults: 2 });",
          "console.log(JSON.stringify(result));",
          "console.error('diagnostic');",
          "return 'ignored';",
        ].join("\n"),
        cwd: directory,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("# Exa runtime documentation");
      expect(result.stdout).toContain(
        JSON.stringify({ query: "tau", options: { numResults: 2 }, authenticated: true }),
      );
      expect(result.stdout).not.toContain("ignored");
      expect(result.stderr).toContain("diagnostic");

      const failed = await runRunner(runnerPath, {
        apiKey: "exa-key",
        code: "throw new Error('program failed')",
        cwd: directory,
      });
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain("program failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
