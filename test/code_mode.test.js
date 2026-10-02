import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { buildTauCodeModeToolDescription, executeTauCodeMode } from "../dist/code_mode/index.js";
import { runTauCodeMode } from "../dist/code_mode/runtime.js";
import { createTauCodeModeClientTool } from "../dist/sdk/index.js";
import { createProtocolImage } from "./helpers/session_protocol_fixtures.js";

const invocation = {
  sessionId: "session-1",
  agentId: "agent-1",
  callId: "call-1",
};

function createDefinition(overrides = {}) {
  return {
    name: "linear",
    documentation: "# Linear API\n\nUse `linear.issues.get(id)` to read an issue.",
    api: {
      issues: {
        get: async ([id], context) => ({ id, invocation: context.invocation }),
      },
    },
    ...overrides,
  };
}

function getTextContent(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("public code-mode runtime", () => {
  it("executes a nested API through the JSON bridge", async () => {
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: 'printText(JSON.stringify(await linear.issues.get("TAU-418")))',
      invocation,
    });

    expect(JSON.parse(getTextContent(result))).toEqual({
      id: "TAU-418",
      invocation,
    });
  });

  it.each(["jpeg", "png", "webp"])("forwards validated %s images from any API", async (format) => {
    const data = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .toFormat(format)
      .toBuffer();
    const block = { type: "image", mimeType: `image/${format}`, data: data.toString("base64") };
    const result = await executeTauCodeMode({
      ...createDefinition({
        api: { screenshot: async () => ({ ...block, annotations: { title: "screen" } }) },
      }),
      code: "await printImage(await linear.screenshot())",
    });

    expect(result).toEqual({ content: [block] });
    expect(getTextContent(result)).not.toContain(block.data);
  });

  it("interleaves console text and awaited images in emission order", async () => {
    const block = createProtocolImage();
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block } }),
      code: [
        'printText("1"); printText("warning");',
        "await printImage(await linear.screenshot());",
        'printText("2");',
        "await printImage(await linear.screenshot());",
        'printText("3");',
      ].join("\n"),
    });
    expect(result.content).toEqual([
      { type: "text", text: "1\nwarning" },
      block,
      { type: "text", text: "2" },
      block,
      { type: "text", text: "3" },
    ]);
  });

  it("keeps image positions while truncating text across multiple blocks", async () => {
    const block = createProtocolImage();
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block } }),
      code: [
        "const block = await linear.screenshot();",
        'printText("頭".repeat(30_000));',
        "await printImage(block);",
        'printText("middle".repeat(30_000));',
        "await printImage(block);",
        'printText("尾".repeat(30_000));',
      ].join("\n"),
    });
    expect(result.content).toEqual([
      { type: "text", text: expect.stringMatching(/^頭+….*tokens truncated…$/) },
      block,
      block,
      { type: "text", text: expect.stringMatching(/^尾+\n\n\[Output truncated for context:/) },
    ]);
    expect(getTextContent(result)).not.toContain("middle");
    expect(getTextContent(result)).not.toContain("�");
  });

  it("keeps emitted output when a synchronous program times out", async () => {
    const block = createProtocolImage();
    const runtime = await runTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block }, timeoutMs: 500 }),
      code: 'printText("before"); await printImage(await linear.screenshot()); printText("after"); while (true) {}',
    });
    expect(runtime.status).toBe("timed-out");
    expect(runtime.result.content[0]).toEqual({ type: "text", text: "before" });
    expect(runtime.result.content[1]).toEqual(block);
    expect(runtime.result.content[2].text).toContain("after");
    expect(runtime.result.content[2].text).toContain("500ms");
  });

  it("bounds console capture without discarding images at the trimmed boundary", async () => {
    const block = createProtocolImage();
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block } }),
      code: 'printText("a".repeat(2 * 1024 * 1024)); await printImage(await linear.screenshot()); printText("b".repeat(2 * 1024 * 1024))',
    });
    expect(result.content[0]).toEqual(block);
    expect(result.content[1].text).toContain("Output truncated for context");
    expect(result.content[1].text).not.toContain("aaaa");
    expect(result.content[1].text.length).toBeLessThan(60_000);
  });

  it("does not forward images merely returned by an API", async () => {
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => createProtocolImage() } }),
      code: 'await linear.screenshot(); printText("received")',
    });
    expect(result).toEqual({ content: [{ type: "text", text: "received" }] });
  });

  it.each([
    [null, "expects"],
    [createProtocolImage({ type: "text" }), "expects"],
    [createProtocolImage({ data: "not base64!" }), "base64"],
    [createProtocolImage({ data: "AB==" }), "base64"],
    [createProtocolImage({ data: "" }), "base64"],
    [createProtocolImage({ mimeType: "image/gif" }), "supports"],
    [createProtocolImage({ mimeType: "image/jpeg" }), "MIME type does not match"],
    [
      createProtocolImage({ data: Buffer.from("plain text").toString("base64") }),
      "MIME type does not match",
    ],
  ])("rejects invalid image blocks outside the sandbox: %j", async (block, message) => {
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { screenshot: async () => block } }),
        code: "await printImage(await linear.screenshot())",
      }),
    ).rejects.toThrow(message);
  });

  it("decodes image pixels before accepting a valid-looking header", async () => {
    const block = createProtocolImage();
    block.data = Buffer.from(block.data, "base64").subarray(0, 55).toString("base64");
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { screenshot: async () => block } }),
        code: "await printImage(await linear.screenshot())",
      }),
    ).rejects.toThrow();
  });

  it("rejects excessive source pixels before decoding or resizing", async () => {
    const data = Buffer.from(createProtocolImage().data, "base64");
    data.writeUInt32BE(10_000, 16);
    data.writeUInt32BE(10_000, 20);
    data.writeUInt32BE(crc32(data.subarray(12, 29)), 29);
    await expect(
      executeTauCodeMode({
        ...createDefinition({
          api: { screenshot: async () => createProtocolImage({ data: data.toString("base64") }) },
        }),
        code: "await printImage(await linear.screenshot())",
      }),
    ).rejects.toThrow("pixel limit");
  });

  it("forwards images larger than 1 MiB without degrading valid model-sized bytes", async () => {
    const bytes = await sharp(randomBytes(1000 * 500 * 3), {
      raw: { width: 1000, height: 500, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const block = createProtocolImage({ data: bytes.toString("base64") });
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block } }),
      code: "await printImage(await linear.screenshot())",
    });
    expect(result.content).toEqual([block]);
  });

  it("applies bridge payload limits to image output", async () => {
    await expect(
      executeTauCodeMode({
        ...createDefinition(),
        code: 'await printImage({ type: "image", data: "A".repeat(64 * 1024 * 1024), mimeType: "image/png" })',
      }),
    ).rejects.toThrow("bridge payload bytes");
  });

  it("resizes images and preserves output order for concurrent helper calls", async () => {
    const large = await sharp({
      create: { width: 4800, height: 2400, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const blocks = [createProtocolImage({ data: large.toString("base64") }), createProtocolImage()];
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshots: async () => blocks } }),
      code: 'await Promise.all((await linear.screenshots()).map((block, index) => { printText(JSON.stringify(index)); return printImage(block); })); printText("done")',
    });
    const metadata = await sharp(
      Buffer.from(result.content.filter((part) => part.type === "image")[0].data, "base64"),
    ).metadata();
    expect(metadata).toMatchObject({ width: 4096, height: 2048 });
    expect(result.content.map((part) => (part.type === "text" ? part.text : "image"))).toEqual([
      "0",
      "image",
      "1",
      "image",
      "done",
    ]);
    expect(result.content.filter((part) => part.type === "image")[1]).toEqual(blocks[1]);
  });

  it("bounds image output and makes invalid output catchable without losing valid images", async () => {
    const block = createProtocolImage();
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block } }),
      code: [
        'try { await printImage({ type: "image", data: "invalid", mimeType: "image/png" }); } catch { printText("rejected"); }',
        "const block = await linear.screenshot();",
        "for (let i = 0; i < 16; i++) await printImage(block);",
        "try { await printImage(block); } catch (error) { printText(error.message); }",
      ].join("\n"),
    });
    expect(result.content.filter((part) => part.type === "image")).toEqual(Array(16).fill(block));
    expect(getTextContent(result)).toContain("rejected");
    expect(getTextContent(result)).toContain("at most 16 images");
  });

  it("keeps images separate from truncated and persisted text", async () => {
    const block = createProtocolImage();
    const persistOutput = vi.fn(async (output) => {
      expect(output.content).not.toContain(block.data);
      return { path: "/tmp/output" };
    });
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { screenshot: async () => block }, persistOutput }),
      code: 'await printImage(await linear.screenshot()); printText("x".repeat(60_000))',
    });
    expect(getTextContent(result)).toContain("Output truncated for context");
    expect(result.content.filter((part) => part.type === "image")).toEqual([block]);
    expect(persistOutput).toHaveBeenCalledOnce();
  });

  it("reserves the image helper name for the shared runtime", async () => {
    await expect(
      executeTauCodeMode({ ...createDefinition({ name: "printImage" }), code: "" }),
    ).rejects.toThrow("non-reserved");
  });

  it("omits undefined object properties from API arguments", async () => {
    const inspect = vi.fn(async ([value]) => value);
    const result = await executeTauCodeMode({
      ...createDefinition({ api: { inspect } }),
      code: [
        "const options = { limit: 100, cursor: undefined, nested: { keep: true, omit: undefined } };",
        "printText(JSON.stringify(await linear.inspect(options)));",
      ].join("\n"),
    });

    expect(JSON.parse(getTextContent(result))).toEqual({ limit: 100, nested: { keep: true } });
    expect(inspect).toHaveBeenCalledWith(
      [{ limit: 100, nested: { keep: true } }],
      expect.any(Object),
    );
  });

  it("rejects undefined API arguments instead of converting them to null", async () => {
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { inspect: async () => null } }),
        code: "await linear.inspect(undefined)",
      }),
    ).rejects.toThrow("Code-mode API arguments must be JSON-serializable values");
  });

  it("prepends canonical runtime documentation", async () => {
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: "printText(docs)",
    });

    expect(getTextContent(result)).toContain("# Code-mode runtime");
    expect(getTextContent(result)).not.toContain("`files`");
    expect(getTextContent(result)).toContain("# Linear API");
  });

  it("provides executable plain-text output examples without dumping response metadata", async () => {
    const docs = await executeTauCodeMode({
      ...createDefinition(),
      code: "printText(docs)",
    });
    const examples = [...getTextContent(docs).matchAll(/```js\n([\s\S]*?)\n```/g)];
    expect(examples).toHaveLength(2);
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: [
        'const items = [{ id: "one", title: "First", metadata: "irrelevant" }];',
        'const blocks = [{ type: "text", text: "Hello" }, { type: "image", data: "private" }, { type: "text", text: "World" }];',
        ...examples.map((match) => match[1]),
      ].join("\n"),
    });
    expect(getTextContent(result)).toBe("one: First\nHello\n\nWorld");
  });

  it("rejects oversized bridge arguments before calling the handler", async () => {
    const echo = vi.fn(async ([value]) => value);

    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { echo } }),
        code: 'await linear.echo("x".repeat(64 * 1024 * 1024))',
      }),
    ).rejects.toThrow("bridge payload bytes");
    expect(echo).not.toHaveBeenCalled();
  });

  it("rejects oversized handler results before returning them to the worker", async () => {
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { large: async () => "x".repeat(64 * 1024 * 1024) } }),
        code: "await linear.large()",
      }),
    ).rejects.toThrow();
  });

  it("rejects non-JSON handler results", async () => {
    await expect(
      executeTauCodeMode({
        ...createDefinition({ api: { invalid: async () => undefined } }),
        code: "printText(JSON.stringify(await linear.invalid()))",
      }),
    ).rejects.toThrow("linear.invalid returned a non-JSON value");
  });

  it("offers every terminal output to optional persistence", async () => {
    const persistOutput = vi.fn(async (output, context) => {
      expect(context.invocation).toEqual(invocation);
      return output.contextTruncated ? { path: "/tmp/linear-output" } : undefined;
    });
    const result = await executeTauCodeMode({
      ...createDefinition(),
      code: 'printText("x".repeat(60_000))',
      invocation,
      persistOutput,
    });

    expect(persistOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        captureTruncated: false,
        contextTruncated: true,
        status: "succeeded",
      }),
      expect.objectContaining({ invocation }),
    );
    expect(getTextContent(result)).toContain("Output truncated for context");
    expect(getTextContent(result)).toContain("saved to /tmp/linear-output");
  });

  it("offers failed output to optional persistence", async () => {
    const persistOutput = vi.fn(async () => undefined);

    await expect(
      executeTauCodeMode({
        ...createDefinition({
          api: {
            fail: async () => {
              throw new Error("integration unavailable");
            },
          },
        }),
        code: "await linear.fail()",
        persistOutput,
      }),
    ).rejects.toThrow("integration unavailable");
    expect(persistOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
      expect.any(Object),
    );
  });

  it("settles cancellation when a handler ignores its abort signal and discards its late reply", async () => {
    let markHandlerStarted;
    const handlerStarted = new Promise((resolve) => {
      markHandlerStarted = resolve;
    });
    let releaseHandler;
    const release = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    let markHandlerFinished;
    const handlerFinished = new Promise((resolve) => {
      markHandlerFinished = resolve;
    });
    const controller = new AbortController();
    const run = executeTauCodeMode({
      ...createDefinition({
        api: {
          stuck: async () => {
            markHandlerStarted();
            await release;
            markHandlerFinished();
            return "late response";
          },
        },
      }),
      code: "await linear.stuck()",
      signal: controller.signal,
    });

    await handlerStarted;
    controller.abort();

    await expect(run).rejects.toThrow("Program was cancelled.");
    releaseHandler();
    await handlerFinished;
  });

  it("passes SDK descriptions through unchanged", async () => {
    const description = "Use the Linear integration exactly as documented here.";
    const tool = createTauCodeModeClientTool({
      ...createDefinition(),
      description,
    });

    expect(tool.schema).toMatchObject({
      name: "linear",
      description,
      parameters: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
      },
    });
    expect(
      await tool.describe(
        { code: 'printText(JSON.stringify(await linear.issues.get("TAU-418")))' },
        {
          ...invocation,
          signal: new AbortController().signal,
          executionEnvironment: { exec: vi.fn() },
        },
      ),
    ).toMatchObject({
      subject: 'printText(JSON.stringify(await linear.issues.get("TAU-418")))',
      subjectWrap: "character",
    });
    await expect(
      tool.execute(
        { code: 'printText(JSON.stringify(await linear.issues.get("TAU-418")))' },
        {
          ...invocation,
          signal: new AbortController().signal,
          executionEnvironment: {
            exec: vi.fn(),
          },
        },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify({ id: "TAU-418", invocation }) }],
      presentation: {
        subject: 'printText(JSON.stringify(await linear.issues.get("TAU-418")))',
        subjectWrap: "character",
      },
    });
  });

  it("provides client-tool execution access to trusted code-mode handlers", async () => {
    const executionEnvironment = {
      exec: vi.fn(async () => ({ output: "clean" })),
    };
    const tool = createTauCodeModeClientTool({
      ...createDefinition({
        api: {
          workspace: {
            status: async (_args, context) =>
              (await context.executionEnvironment.exec("git status --short")).output,
          },
        },
      }),
      description: "Inspect the workspace.",
    });

    await expect(
      tool.execute(
        { code: "printText(await linear.workspace.status())" },
        {
          ...invocation,
          signal: new AbortController().signal,
          executionEnvironment,
        },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "clean" }],
      presentation: {
        subject: "printText(await linear.workspace.status())",
        subjectWrap: "character",
      },
    });
    expect(executionEnvironment.exec).toHaveBeenCalledWith("git status --short");
  });

  it("builds the progressive-disclosure description only when requested", () => {
    expect(
      buildTauCodeModeToolDescription({
        name: "linear",
        description: "Search Linear issues.",
      }),
    ).toBe(
      "Search Linear issues. When this tool is useful, first check whether its documentation is already visible in the conversation context. If it is not, your first call must be a documentation-only program that does nothing except print docs with printText(docs). Read the returned documentation before writing a later tool call that uses linear. Once the documentation is visible, use the API normally without reloading it, and do not guess API signatures.",
    );
  });

  it("does not pass parent eval flags to the file-backed worker", () => {
    const moduleUrl = pathToFileURL(resolve("dist/code_mode/index.js")).href;
    const script = [
      `import { executeTauCodeMode } from ${JSON.stringify(moduleUrl)};`,
      "const result = await executeTauCodeMode({",
      '  name: "linear",',
      '  documentation: "# Linear API",',
      "  api: { echo: async ([value]) => value },",
      '  code: "printText(JSON.stringify(await linear.echo(42)))",',
      "});",
      "process.stdout.write(result.content[0].text);",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("42");
  });
});

describe("code-mode command adapter", () => {
  it("reads and writes the command client-tool framing", async () => {
    const moduleUrl = pathToFileURL(resolve("dist/code_mode/index.js")).href;
    const script = [
      `import(${JSON.stringify(moduleUrl)}).then(async ({ runTauCodeModeCommand }) => {`,
      "  await runTauCodeModeCommand({",
      '    name: "linear",',
      '    documentation: "# Linear API",',
      "    api: { echo: async ([value], context) => ({ value, invocation: context.invocation }) },",
      "  });",
      "});",
    ].join("\n");
    const request = {
      version: 5,
      type: "prepare",
      ...invocation,
      toolName: "linear",
      arguments: {
        code: 'printText(JSON.stringify(await linear.echo("hello")))',
      },
    };
    const result = await runCommandWithOpenStdin(script, request);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const frames = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames).toEqual([
      {
        version: 5,
        type: "ready",
        presentation: expect.objectContaining({
          subject: 'printText(JSON.stringify(await linear.echo("hello")))',
          subjectWrap: "character",
        }),
      },
      {
        version: 5,
        type: "result",
        ok: true,
        content: [{ type: "text", text: JSON.stringify({ value: "hello", invocation }) }],
        presentation: {
          subject: 'printText(JSON.stringify(await linear.echo("hello")))',
          subjectWrap: "character",
        },
      },
    ]);
  });

  it("stops when terminated during asynchronous command description", async () => {
    const moduleUrl = pathToFileURL(resolve("dist/sdk/index.js")).href;
    const script = [
      `import { runTauClientToolCommand } from ${JSON.stringify(moduleUrl)};`,
      "await runTauClientToolCommand({",
      '  name: "wait",',
      "  describe: async () => {",
      '    process.stderr.write("describing\\n");',
      "    await new Promise(() => {});",
      "  },",
      '  execute: () => "unreachable",',
      "});",
    ].join("\n");
    const result = await runCommandAndTerminate(
      script,
      {
        version: 5,
        type: "prepare",
        ...invocation,
        toolName: "wait",
        arguments: {},
      },
      "stderr",
      "describing",
    );

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("stops when terminated while awaiting execution authorization", async () => {
    const moduleUrl = pathToFileURL(resolve("dist/sdk/index.js")).href;
    const script = [
      `import { runTauClientToolCommand } from ${JSON.stringify(moduleUrl)};`,
      "await runTauClientToolCommand({",
      '  name: "wait",',
      '  execute: () => "unreachable",',
      "});",
    ].join("\n");
    const result = await runCommandAndTerminate(
      script,
      {
        version: 5,
        type: "prepare",
        ...invocation,
        toolName: "wait",
        arguments: {},
      },
      "stdout",
      '"type":"ready"',
    );

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("aborts the handler when protocol input closes", () => {
    const moduleUrl = pathToFileURL(resolve("dist/sdk/index.js")).href;
    const script = [
      `import { runTauClientToolCommand } from ${JSON.stringify(moduleUrl)};`,
      "await runTauClientToolCommand({",
      '  name: "wait",',
      '  describe: () => ({ subject: "input" }),',
      "  execute: async (_args, context) => {",
      "    await new Promise((_resolve, reject) => {",
      '      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });',
      "    });",
      '    return "unreachable";',
      "  },",
      "});",
    ].join("\n");
    const request = {
      version: 5,
      type: "prepare",
      ...invocation,
      toolName: "wait",
      arguments: {},
    };
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${JSON.stringify(request)}\n`,
      timeout: 2000,
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("client-tool command input closed during execution");
  });
});

function runCommandAndTerminate(script, request, streamName, marker) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let terminated = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectResult(new Error(`command did not emit ${streamName} marker '${marker}'`));
    }, 2000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const maybeTerminate = () => {
      const content = streamName === "stdout" ? stdout : stderr;
      if (!terminated && content.includes(marker)) {
        terminated = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      maybeTerminate();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      maybeTerminate();
    });
    child.on("error", rejectResult);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolveResult({ status, signal, stdout, stderr });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function runCommandWithOpenStdin(script, request) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--eval", script], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let executeSent = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          if (!executeSent && JSON.parse(line).type === "ready") {
            executeSent = true;
            child.stdin.write(`${JSON.stringify({ version: 5, type: "execute" })}\n`);
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectResult);
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
