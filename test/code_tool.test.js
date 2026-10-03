import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTauCodeMode } from "../dist/code_mode/runtime.js";
import { createBashCapability } from "../dist/core/code_mode/bash.js";
import { createModelsCapability } from "../dist/core/code_mode/models.js";
import { bindCodeModeSdk } from "../dist/core/code_mode/sdk.js";
import { requestOpenRouterChat } from "../dist/core/models/openrouter.js";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { createCodeToolDefinition } from "../dist/core/tools/code.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES } from "../dist/protocol/session_protocol.js";
import { createProtocolImage } from "./helpers/session_protocol_fixtures.js";

function context(overrides = {}) {
  return {
    agentId: "agent",
    turnId: "turn",
    assistantMessageId: "assistant",
    signal: new AbortController().signal,
    emitActivity: vi.fn(async () => {}),
    ...overrides,
  };
}
function execute(tool, code, executionContext = context()) {
  return tool.execute({ id: "code-call", name: "code", arguments: { code } }, executionContext);
}
function text(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
function chatReply() {
  return {
    model: "openai/gpt-6-luna",
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, cost: 0.02 },
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "summary" } }],
  };
}

describe("code composition", () => {
  it("scopes default capability policies without restricting the composition tool", () => {
    const tool = createCodeToolDefinition({
      backend: createLocalToolExecutionBackend(),
      cwd: process.cwd(),
      allowedTools: ["bash", "web", "history", "nook", "mcp", "models"],
      history: {},
      mcp: { available: true },
      config: { nook: { domain: "nook.example.com" } },
      bashJobs: new BashJobRegistry(),
    });
    const description = tool.schema.description;
    for (const name of ["bash", "web", "history", "nook", "mcp", "models"])
      expect(description).toContain(`tau.${name}:`);
    for (const name of ["web", "history", "nook"])
      expect(description.toLowerCase()).toContain(`use tau.${name} only`);
    expect(description).not.toMatch(/(?:use this tool only|the tool is read-only)/i);
    expect(description).toContain("tau.history is read-only");
  });

  it("runs the SDK composition examples with bounded calls and selected output", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      truncated: false,
      timedOut: false,
      aborted: false,
      stdout: "change footprint",
      output: "command output",
    }));
    const chat = vi.fn(async () => ({ finish_reason: "stop", answer: "summary" }));
    const search = vi.fn(async () => ({
      results: [{ title: "source", url: "https://example.com" }],
      statuses: [{ id: "https://example.com", status: "success" }],
    }));
    const sdk = bindCodeModeSdk(
      Object.entries({ bash: { run }, models: { chat }, web: { search } }).map(([name, api]) => ({
        name,
        api,
        description: "test",
        documentation: "test",
      })),
    );
    const examples = [...sdk.documentation.matchAll(/```js\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    expect(examples).toHaveLength(3);
    for (const code of examples) {
      const result = await runTauCodeMode({ name: "tau", ...sdk, code });
      expect(result.status).toBe("succeeded");
    }
    expect(run).toHaveBeenCalledTimes(3);
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0][0][0].prompt).toContain("change footprint");
    expect(search).toHaveBeenCalledTimes(2);
    run.mockResolvedValueOnce({ exitCode: 0, truncated: true, stdout: "partial" });
    const incomplete = await runTauCodeMode({ name: "tau", ...sdk, code: examples[0] });
    expect(incomplete.status).toBe("failed");
    expect(chat).toHaveBeenCalledOnce();
    run.mockRejectedValueOnce(new Error("unavailable"));
    const partial = await runTauCodeMode({ name: "tau", ...sdk, code: examples[2] });
    expect(partial.status).toBe("succeeded");
    expect(text(partial.result)).toContain("command output");
  });

  it("owns model and media validation before adapter access", async () => {
    const fetchImpl = vi.fn();
    const mediaAdapter = { readFile: vi.fn(), probe: vi.fn() };
    const options = { config: {}, signal: new AbortController().signal, fetchImpl, mediaAdapter };
    const input = { model: "openai/gpt-6-luna", prompt: "Describe", attachments: [] };
    for (const invalid of [
      { ...input, model: "unknown" },
      { ...input, reasoning: "unsupported" },
      { ...input, prompt: " " },
      { ...input, attachments: [{ kind: "audio", path: "input.wav" }] },
    ])
      await expect(requestOpenRouterChat(invalid, options)).rejects.toThrow();
    expect(mediaAdapter.readFile).not.toHaveBeenCalled();
    expect(mediaAdapter.probe).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("binds only selected capabilities and discloses their references separately", async () => {
    const backend = createLocalToolExecutionBackend();
    const jobs = new BashJobRegistry();
    const history = { search: vi.fn(async () => ({ sessions: [{ sessionId: "past" }] })) };
    const tool = createCodeToolDefinition({
      backend,
      cwd: process.cwd(),
      allowedTools: ["history"],
      history,
      config: {},
      bashJobs: jobs,
    });
    const index = text(await execute(tool, "printText(docs)"));
    expect(index).toContain("tau.history");
    expect(index).not.toContain("tau.bash:");
    expect(index).not.toContain("nextCursor");
    const reference = text(await execute(tool, 'printText(await tau.docs("history"))'));
    expect(reference).toContain("nextCursor");
    const unavailable = await execute(tool, 'printText(await tau.docs("bash"))');
    expect(unavailable.outcome).toBe("failed");
    const result = await execute(
      tool,
      'printText([typeof tau.bash, typeof console, typeof image, typeof files].join(" ")); const page = await tau.history.search({}); printText(page.sessions[0].sessionId);',
    );
    expect(result.outcome).toBe("succeeded");
    expect(text(result)).toBe("undefined undefined undefined undefined\npast");
    expect(history.search).toHaveBeenCalledOnce();
    expect(
      createCodeToolDefinition({
        backend,
        cwd: process.cwd(),
        allowedTools: [],
        config: {},
        bashJobs: jobs,
      }),
    ).toBeUndefined();
  });

  it.each([
    { label: "omitted", stdin: undefined },
    { label: "empty", stdin: "" },
    { label: "text", stdin: "héllo\n$HOME; $(printf injected)\n'quoted'\u0000" },
  ])("supplies $label foreground stdin and closes it", async ({ stdin }) => {
    const backend = createLocalToolExecutionBackend();
    const run = vi.spyOn(backend, "runBash");
    const tool = createCodeToolDefinition({
      backend,
      cwd: process.cwd(),
      allowedTools: ["bash"],
      config: {},
      bashJobs: new BashJobRegistry(),
    });
    const options = JSON.stringify({ command: "cat", stdin, timeout: 1000 });
    const result = await execute(
      tool,
      `const result = await tau.bash.run(${options}); printText(JSON.stringify(result));`,
    );
    expect(result.outcome).toBe("succeeded");
    expect(JSON.parse(text(result))).toMatchObject({
      stdout: stdin ?? "",
      stderr: "",
      exitCode: 0,
      truncated: false,
      timedOut: false,
      aborted: false,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1].stdin).toEqual(
      stdin === undefined ? undefined : Buffer.from(stdin, "utf8"),
    );
  });

  it("bounds foreground stdin by UTF-8 bytes before launching commands", async () => {
    const runBash = vi.fn(async () => ({}));
    const jobs = new BashJobRegistry();
    const start = vi.spyOn(jobs, "start");
    const capability = createBashCapability({ runBash }, process.cwd(), jobs);
    for (const stdin of [
      null,
      123,
      "x".repeat(SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES + 1),
      "é".repeat(SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES / 2 + 1),
    ]) {
      await expect(capability.api.run([{ command: "cat", stdin }], context())).rejects.toThrow();
    }
    await expect(
      capability.api.start([{ command: "cat", stdin: "data" }], context()),
    ).rejects.toThrow();
    expect(runBash).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await capability.api.run(
      [{ command: "cat", stdin: "é".repeat(SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES / 2) }],
      context(),
    );
    expect(runBash).toHaveBeenCalledOnce();
    expect(runBash.mock.calls[0][1].stdin.length).toBe(SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES);
  });

  it("composes structured shell data and history without model-facing intermediate output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-code-test-"));
    const backend = createLocalToolExecutionBackend();
    const jobs = new BashJobRegistry();
    const history = { search: vi.fn(async () => ({ sessions: [{ sessionId: "past" }] })) };
    try {
      await writeFile(
        join(directory, "input.json"),
        JSON.stringify({ query: "needle", large: "x".repeat(100_000) }),
      );
      const tool = createCodeToolDefinition({
        backend,
        cwd: directory,
        allowedTools: ["bash", "history"],
        history,
        config: {},
        bashJobs: jobs,
      });
      const result = await execute(
        tool,
        'const run = await tau.bash.run({ command: "cat input.json" }); if (run.truncated || run.exitCode !== 0) throw new Error("incomplete"); const input = JSON.parse(run.stdout); const page = await tau.history.search({ query: input.query }); printText(page.sessions[0].sessionId);',
      );
      expect(result.outcome).toBe("succeeded");
      expect(text(result)).toBe("past");
      expect(history.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: "needle" }),
        expect.any(AbortSignal),
      );
    } finally {
      await jobs.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares composed background jobs with direct tools across registries", async () => {
    const backend = createLocalToolExecutionBackend();
    const jobs = new BashJobRegistry();
    const registry = ToolCatalog.createSubagentRegistry(["bash"], backend, process.cwd(), {}, jobs);
    try {
      const started = await execute(
        registry.get("code"),
        'const job = await tau.bash.start({ command: "sleep 30" }); printText(job.id);',
      );
      expect(started.outcome).toBe("succeeded");
      const id = text(started);
      expect(jobs.hasRunning).toBe(true);
      const direct = await registry
        .get("read_bash_job")
        .execute(
          { id: "read", name: "read_bash_job", arguments: { id, includeOutput: false } },
          context(),
        );
      expect(text(direct)).toContain(id);
      const stopped = await execute(
        registry.get("code"),
        `const job = await tau.bash.stop({ id: ${JSON.stringify(id)} }); printText(job.status);`,
      );
      expect(text(stopped)).toBe("stopped");
      expect(jobs.hasRunning).toBe(false);
    } finally {
      await jobs.dispose();
    }
  });

  it("passes inline MCP-shaped media directly to inference and returns provider usage", async () => {
    const backend = { readFileBinary: vi.fn() };
    const fetchImpl = vi.fn(async () => Response.json(chatReply()));
    const image = createProtocolImage();
    const sdk = bindCodeModeSdk([
      {
        name: "mcp",
        description: "test",
        documentation: "test",
        api: { screenshot: async () => image },
      },
      createModelsCapability(backend, { apiKeys: { openrouter: "secret" } }, fetchImpl),
    ]);
    const result = await runTauCodeMode({
      name: "tau",
      ...sdk,
      code: 'const image = await tau.mcp.screenshot(); const result = await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Describe", attachments: [{ type: "image", data: image.data, mimeType: image.mimeType }] }); printText(result.answer); printText(JSON.stringify(result.usage));',
    });
    expect(result.status).toBe("succeeded");
    expect(text(result.result)).toContain("summary");
    expect(JSON.parse(text(result.result).split("\n")[1])).toEqual(chatReply().usage);
    expect(backend.readFileBinary).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content[1].image_url.url).toBe(
      `data:${image.mimeType};base64,${image.data}`,
    );
    expect(text(result.result)).not.toContain("secret");
  });

  it("rejects an unusable response even when it includes valid usage", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...chatReply(), choices: [] }));
    const sdk = bindCodeModeSdk([
      createModelsCapability({}, { apiKeys: { openrouter: "secret" } }, fetchImpl),
    ]);
    const result = await runTauCodeMode({
      name: "tau",
      ...sdk,
      code: 'await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Describe" })',
    });
    expect(result.status).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous or mismatched media before reading files or making requests", async () => {
    const backend = { readFileBinary: vi.fn() };
    const fetchImpl = vi.fn();
    const sdk = bindCodeModeSdk([createModelsCapability(backend, {}, fetchImpl)]);
    const image = createProtocolImage();
    for (const attachment of [
      { type: "image", path: "file.png", data: image.data, mimeType: image.mimeType },
      { type: "image", data: image.data, mimeType: "image/jpeg" },
      { type: "image", data: "invalid", mimeType: "image/png" },
    ]) {
      const result = await runTauCodeMode({
        name: "tau",
        ...sdk,
        code: `await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Describe", attachments: [${JSON.stringify(attachment)}] })`,
      });
      expect(result.status).toBe("failed");
    }
    expect(backend.readFileBinary).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads composed media through the scoped backend and cancels target probing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-model-path-"));
    const backend = createLocalToolExecutionBackend({ env: { cwd: () => directory } });
    const readFileBinary = vi.spyOn(backend, "readFileBinary");
    const probeStarted = {};
    probeStarted.promise = new Promise((resolve) => {
      probeStarted.resolve = resolve;
    });
    let probeSignal;
    const runNodeScript = vi
      .spyOn(backend, "runNodeScript")
      .mockImplementation(async (_script, _args, options) => {
        probeSignal = options.signal;
        probeStarted.resolve();
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
        return {
          exitCode: null,
          aborted: true,
          timedOut: false,
          truncated: false,
          stdout: "",
          stderr: "",
          output: "",
          closeSignal: "SIGTERM",
        };
      });
    const fetchImpl = vi.fn(async () => Response.json(chatReply()));
    const controller = new AbortController();
    const sdk = bindCodeModeSdk([
      createModelsCapability(backend, { apiKeys: { openrouter: "secret" } }, fetchImpl),
    ]);
    try {
      await writeFile(
        join(directory, "image.png"),
        Buffer.from(createProtocolImage().data, "base64"),
      );
      const image = await runTauCodeMode({
        name: "tau",
        ...sdk,
        code: 'await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Describe", attachments: [{ type: "image", path: "image.png" }] })',
      });
      expect(image.status).toBe("succeeded");
      expect(readFileBinary).toHaveBeenCalledWith("image.png", { maxBytes: 5_000_000 });
      const wav = Buffer.alloc(46);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(38, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(2, 40);
      await writeFile(join(directory, "audio.wav"), wav);
      const probing = runTauCodeMode({
        name: "tau",
        ...sdk,
        signal: controller.signal,
        code: 'await tau.models.chat({ model: "google/gemini-3.8-flash", prompt: "Describe", attachments: [{ type: "audio", path: "audio.wav" }] })',
      });
      await probeStarted.promise;
      controller.abort();
      expect((await probing).status).toBe("cancelled");
      expect(probeSignal.aborted).toBe(true);
      expect(runNodeScript).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates cancellation into model requests without retrying", async () => {
    const controller = new AbortController();
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const fetchImpl = vi.fn(async (_url, options) => {
      started();
      return await new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
    });
    const sdk = bindCodeModeSdk([
      createModelsCapability({}, { apiKeys: { openrouter: "secret" } }, fetchImpl),
    ]);
    const running = runTauCodeMode({
      name: "tau",
      ...sdk,
      signal: controller.signal,
      code: 'await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Describe" })',
    });
    await ready;
    controller.abort();
    expect((await running).status).toBe("cancelled");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("bounds Unicode and line output locally and rejects non-string printing", async () => {
    const sdk = bindCodeModeSdk([]);
    const result = await runTauCodeMode({
      name: "tau",
      ...sdk,
      code: 'printText(truncate("頭".repeat(100) + "尾".repeat(100), { maxChars: 40 })); printText(truncateLines("a\\nb\\nc\\nd", { maxLines: 3 }));',
    });
    expect(result.status).toBe("succeeded");
    const lines = text(result.result).split("\n");
    expect([...lines[0]]).toHaveLength(40);
    expect(lines[0]).toMatch(/^頭.*尾$/);
    expect(lines.slice(1)).toEqual(["a", "[2 lines omitted]", "d"]);
    const invalid = await runTauCodeMode({ name: "tau", ...sdk, code: "printText({ value: 1 })" });
    expect(invalid.status).toBe("failed");
  });
});
