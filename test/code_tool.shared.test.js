import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { runTauCodeMode } from "../dist/code_mode/runtime.js";
import { createBashCapability } from "../dist/core/code_mode/bash.js";
import { createModelsCapability } from "../dist/core/code_mode/models.js";
import { bindCodeModeSdk } from "../dist/core/code_mode/sdk.js";
import { requestOpenRouterChat } from "../dist/core/models/openrouter.js";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { createCodeToolDefinition } from "../dist/core/tools/code.js";
import { CodeJobRegistry } from "../dist/core/tools/code_jobs.js";
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
  it.each([3_600_001])(
    "rejects an invalid program timeout %s before execution",
    async (timeout) => {
      const history = { search: vi.fn() };
      const tool = createCodeToolDefinition({
        backend: createLocalToolExecutionBackend(),
        cwd: process.cwd(),
        allowedTools: ["history"],
        history,
        config: {},
        bashJobs: new BashJobRegistry(),
        codeJobs: new CodeJobRegistry(),
      });
      const result = await tool.execute(
        {
          id: "invalid",
          name: "code",
          arguments: { code: "await tau.history.search({})", timeout },
        },
        context(),
      );
      expect(result.outcome).toBe("blocked");
      expect(history.search).not.toHaveBeenCalled();
    },
  );

  it("enforces the overall program deadline including worker startup", async () => {
    const tool = createCodeToolDefinition({
      backend: createLocalToolExecutionBackend(),
      cwd: process.cwd(),
      allowedTools: ["bash"],
      config: {},
      bashJobs: new BashJobRegistry(),
      codeJobs: new CodeJobRegistry(),
    });
    const executionContext = context();
    const result = await tool.execute(
      {
        id: "deadline",
        name: "code",
        arguments: { code: "while (true) {}", timeout: 500 },
      },
      executionContext,
    );
    expect(result.outcome).toBe("cancelled");
    expect(executionContext.emitActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "code_mode_finished", status: "error" }),
    );
  });

  it("forwards bounded foreground Bash timeouts and rejects invalid ones before launch", async () => {
    const runBash = vi.fn(async () => ({}));
    const capability = createBashCapability({ runBash }, process.cwd(), new BashJobRegistry());
    await capability.api.run([{ command: "true" }], context());
    expect(runBash).toHaveBeenLastCalledWith(
      "true",
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    await capability.api.run([{ command: "true", timeout: 3_600_000 }], context());
    expect(runBash).toHaveBeenLastCalledWith(
      "true",
      expect.objectContaining({ timeoutMs: 3_600_000 }),
    );
    runBash.mockClear();
    for (const timeout of [0, -1, "60000", null, Infinity]) {
      await expect(capability.api.run([{ command: "true", timeout }], context())).rejects.toThrow();
    }
    expect(runBash).not.toHaveBeenCalled();
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

  it("exposes only selected capabilities inside the sandbox", async () => {
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
      codeJobs: new CodeJobRegistry(),
    });
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
        codeJobs: new CodeJobRegistry(),
      }),
    ).toBeUndefined();
  });

  it.each([{ label: "text", stdin: "héllo\n$HOME; $(printf injected)\n'quoted'\u0000" }])(
    "supplies $label foreground stdin and closes it",
    async ({ stdin }) => {
      const backend = createLocalToolExecutionBackend();
      const run = vi.spyOn(backend, "runBash");
      const capability = createBashCapability(backend, process.cwd(), new BashJobRegistry());
      const result = await capability.api.run(
        [{ command: "cat", stdin, timeout: 5000 }],
        context(),
      );
      expect(result).toMatchObject({
        stdout: stdin,
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
    },
  );

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

  it("shares composed background jobs with direct tools across registries", async () => {
    const backend = createLocalToolExecutionBackend();
    vi.spyOn(backend, "runBash").mockImplementation(
      (_command, options) =>
        new Promise((resolve) => {
          options.onStarted();
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                exitCode: null,
                aborted: true,
                closeSignal: "SIGTERM",
                truncated: false,
              }),
            { once: true },
          );
        }),
    );
    const jobs = new BashJobRegistry();
    const registry = ToolCatalog.createSubagentRegistry(
      ["bash"],
      backend,
      process.cwd(),
      {},
      jobs,
      new CodeJobRegistry(),
    );
    try {
      const started = await execute(
        registry.get("code"),
        'const job = await tau.bash.start({ command: "server" }); printText(job.id);',
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
      const stopped = await registry
        .get("stop_bash_job")
        .execute({ id: "stop", name: "stop_bash_job", arguments: { id } }, context());
      expect(stopped.outcome).toBe("succeeded");
      expect(jobs.read([id])[0].status).toBe("stopped");
      expect(jobs.hasRunning).toBe(false);
    } finally {
      await jobs.dispose();
    }
  });

  it("passes a chat schema to OpenRouter and returns parsed data through code mode", async () => {
    const schema = {
      type: "object",
      properties: { person: { type: "string" } },
      required: ["person"],
      additionalProperties: false,
    };
    const reply = chatReply();
    reply.choices[0].message.content = '{"person":"Ada"}';
    const fetchImpl = vi.fn(async () => Response.json(reply));
    const sdk = bindCodeModeSdk([
      createModelsCapability({}, { apiKeys: { openrouter: "secret" } }, fetchImpl),
    ]);
    const result = await runTauCodeMode({
      name: "tau",
      ...sdk,
      code: `const result = await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Extract Ada", schema: ${JSON.stringify(schema)} }); printText(result.answer.person); printText(JSON.stringify(result.usage));`,
    });
    expect(result.status).toBe("succeeded");
    expect(text(result.result).split("\n")[0]).toBe("Ada");
    expect(JSON.parse(text(result.result).split("\n")[1])).toEqual(reply.usage);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema },
      },
      provider: { require_parameters: true },
    });
  });

  it.each(["openai/gpt-6-luna-decisions"])(
    "composes ordered path and inline %s images through the scoped backend",
    async (model) => {
      const bytes = await sharp({
        create: { width: 280, height: 280, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer();
      const image = { data: bytes.toString("base64"), mimeType: "image/png" };
      const backend = {
        readFileBinary: vi.fn(async () => ({ content: bytes })),
        runNodeScript: vi.fn(),
      };
      const reply = {
        model,
        answers: { same: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 180, output_tokens: 0 },
      };
      const fetchImpl = vi.fn(async () => Response.json(reply));
      const capability = createModelsCapability(
        backend,
        { apiKeys: { openrouter: "secret" } },
        fetchImpl,
      );
      const result = await capability.api.decisions(
        [
          {
            model,
            state: "Compare the two images.",
            questions: { same: { type: "noul", instructions: "Do the images look the same?" } },
            attachments: [
              { type: "image", path: "screenshot.png" },
              { type: "image", ...image },
            ],
          },
        ],
        context(),
      );
      expect(result.answers).toEqual(reply.answers);
      expect(backend.readFileBinary).toHaveBeenCalledWith("screenshot.png", {
        maxBytes: 32 * 1024 * 1024,
      });
      expect(backend.runNodeScript).not.toHaveBeenCalled();
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body).state).toEqual([
        "Compare the two images.",
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
        },
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
      ]);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("rejects unsupported, ambiguous, invalid, and excessive decision images before file access or inference", async () => {
    const backend = { readFileBinary: vi.fn() };
    const fetchImpl = vi.fn();
    const capability = createModelsCapability(backend, {}, fetchImpl);
    const image = createProtocolImage();
    const inline = { type: "image", data: image.data, mimeType: image.mimeType };
    const input = {
      model: "openai/gpt-6-luna-decisions",
      state: "Compare",
      questions: { q: { type: "noul", instructions: "Are they the same?" } },
    };
    for (const attachments of [
      [{ ...inline, path: "image.png" }],
      [{ ...inline, data: "invalid" }],
      [{ ...inline, mimeType: "image/jpeg" }],
      [{ ...inline, data: "A".repeat(4 * Math.ceil((32 * 1024 * 1024) / 3) + 1) }],
      Array.from({ length: 65 }, () => ({ type: "image", path: "missing.png" })),
      [{ type: "audio", path: "missing.wav" }],
      [{ type: "video", path: "missing.mp4" }],
    ]) {
      await expect(
        capability.api.decisions([{ ...input, attachments }], context()),
      ).rejects.toThrow();
    }
    await expect(
      capability.api.decisions(
        [
          {
            ...input,
            model: "typesafe/jev-1.14",
            attachments: [inline],
          },
        ],
        context(),
      ),
    ).rejects.toThrow();
    expect(backend.readFileBinary).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels decision image preparation before requesting inference", async () => {
    const controller = new AbortController();
    const image = createProtocolImage();
    const backend = {
      readFileBinary: vi.fn(async () => {
        controller.abort();
        return { content: Buffer.from(image.data, "base64") };
      }),
    };
    const fetchImpl = vi.fn();
    const capability = createModelsCapability(backend, {}, fetchImpl);
    await expect(
      capability.api.decisions(
        [
          {
            model: "openai/gpt-6-luna-decisions",
            state: "Inspect",
            questions: { q: { type: "noul", instructions: "Is this an image?" } },
            attachments: [{ type: "image", path: "image.png" }],
          },
        ],
        context({ signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(backend.readFileBinary).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects ambiguous or mismatched media before reading files or making requests", async () => {
    const image = createProtocolImage();
    const backend = {
      readFileBinary: vi.fn(async () => ({ content: Buffer.from(image.data, "base64") })),
    };
    const fetchImpl = vi.fn(async () => Response.json(chatReply()));
    const capability = createModelsCapability(
      backend,
      { apiKeys: { openrouter: "secret" } },
      fetchImpl,
    );
    const attachments = [
      { type: "image", path: "file.png", data: image.data, mimeType: image.mimeType },
      { type: "image", data: image.data, mimeType: "image/jpeg" },
      { type: "image", data: "invalid", mimeType: "image/png" },
    ];
    for (const attachment of attachments) {
      await expect(
        capability.api.chat(
          [
            {
              model: "openai/gpt-6-luna",
              prompt: "Describe",
              attachments: [attachment],
            },
          ],
          context(),
        ),
      ).rejects.toThrow();
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
    const capability = createModelsCapability(
      backend,
      { apiKeys: { openrouter: "secret" } },
      fetchImpl,
    );
    try {
      await writeFile(
        join(directory, "image.png"),
        Buffer.from(createProtocolImage().data, "base64"),
      );
      await capability.api.chat(
        [
          {
            model: "openai/gpt-6-luna",
            prompt: "Describe",
            attachments: [{ type: "image", path: "image.png" }],
          },
        ],
        context(),
      );
      expect(readFileBinary).toHaveBeenCalledWith("image.png", { maxBytes: 32 * 1024 * 1024 });
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
      const probing = capability.api
        .chat(
          [
            {
              model: "google/gemini-3.8-flash",
              prompt: "Describe",
              attachments: [{ type: "audio", path: "audio.wav" }],
            },
          ],
          context({ signal: controller.signal }),
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await probeStarted.promise;
      controller.abort();
      expect((await probing).error).toBeDefined();
      expect(probeSignal.aborted).toBe(true);
      expect(runNodeScript).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["chat"])(
    "propagates cancellation into %s model requests without retrying",
    async (operation) => {
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
        code:
          operation === "chat"
            ? 'await tau.models.chat({ model: "openai/gpt-6-luna", prompt: "Describe" })'
            : 'await tau.models.decisions({ model: "openai/gpt-6-luna-decisions", state: "Inspect", questions: { q: { type: "noul", instructions: "Is this valid?" } } })',
      });
      await ready;
      controller.abort();
      expect((await running).status).toBe("cancelled");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});
