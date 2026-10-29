import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { BashJobRegistry, createJobToolDefinitions } from "../dist/core/tools/bash_jobs.js";
import { createCodeToolDefinition } from "../dist/core/tools/code.js";
import { CodeJobRegistry } from "../dist/core/tools/code_jobs.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

const signal = () => new AbortController().signal;
const context = (value = signal()) => ({
  signal: value,
  emitActivity: async () => {},
  agentId: "agent",
  turnId: "turn",
  assistantMessageId: "message",
});
const text = (result) =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
const call = (tool, args, value = signal()) =>
  tool.execute({ id: "call", name: tool.schema.name, arguments: args }, context(value));

it("loads saved JavaScript once through the backend and exposes JSON input without Node authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-code-test-"));
  const backend = createLocalToolExecutionBackend();
  const read = vi.spyOn(backend, "readFileBinary");
  const jobs = new CodeJobRegistry();
  const tool = createCodeToolDefinition({
    backend,
    cwd: directory,
    config: {},
    allowedTools: ["bash"],
    bashJobs: new BashJobRegistry(),
    codeJobs: jobs,
  });
  try {
    await writeFile(
      join(directory, "script.js"),
      "printText(JSON.stringify({ input, node: typeof process, imports: typeof require, network: typeof fetch }));",
    );
    const input = { nested: [false, null, "日本語", 42], __protoText: "value" };
    const result = await call(tool, { file: "script.js", input });
    expect(result.outcome).toBe("succeeded");
    expect(JSON.parse(text(result))).toEqual({
      input,
      node: "undefined",
      imports: "undefined",
      network: "undefined",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(join(directory, "script.js"), {
      maxBytes: 1024 * 1024,
    });
    expect(text(await call(tool, { code: "printText(JSON.stringify(input))" }))).toBe("null");
    for (const args of [
      {},
      { code: "1", file: "script.js" },
      { file: "script.ts" },
      { code: "1", background: true, timeout: 5 },
      { code: "1", background: true, maxOutputTokens: 5 },
      { code: "1", input: "x".repeat(1024 * 1024) },
    ]) {
      expect((await call(tool, args)).outcome).toBe("blocked");
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect((await call(tool, { file: "missing.js" })).outcome).toBe("failed");
    await writeFile(join(directory, "large.js"), " ".repeat(1024 * 1024 + 1));
    expect((await call(tool, { file: "large.js" })).outcome).toBe("failed");
  } finally {
    await jobs.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps live output and capability ownership after launch, and cancels waits independently", async () => {
  const jobs = new CodeJobRegistry();
  const backend = createLocalToolExecutionBackend();
  const turn = new AbortController();
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let requestSignal;
  const id = jobs.start({
    backend,
    cwd: "/workspace",
    source: "workflow.js",
    signal: turn.signal,
    program: {
      name: "tau",
      documentation: "test",
      code: 'printText("progress"); await tau.pause(); printText("unexpected");',
      api: {
        pause: async (_args, context) => {
          requestSignal = context.signal;
          entered();
          await new Promise((_, reject) =>
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            }),
          );
          return null;
        },
      },
    },
  });
  try {
    turn.abort();
    await ready;
    expect(requestSignal.aborted).toBe(false);
    const snapshot = await jobs.inspect([id]);
    expect(snapshot.text).toContain("progress");
    const path = snapshot.text.match(/^text_log: (.+)$/m)[1];
    expect(await readFile(path, "utf8")).toContain("progress");
    expect(await jobs.waitJobs([id], 1, signal())).toBe(true);
    const waiter = new AbortController();
    const wait = jobs.waitJobs([id], 300000, waiter.signal);
    waiter.abort();
    await expect(wait).rejects.toBeDefined();
    expect(requestSignal.aborted).toBe(false);
    expect(jobs.hasRunning).toBe(true);
    await jobs.stopJob(id);
    expect(requestSignal.aborted).toBe(true);
    expect(await jobs.waitJobs([id], 1, signal())).toBe(false);
    const stopped = await jobs.inspect([id]);
    expect(stopped.text).toContain("status: stopped");
    expect(stopped.text).not.toContain("unexpected");
    const metadata = await jobs.inspect([id], false);
    expect(metadata.text).not.toContain("progress");
    expect(metadata.text).not.toContain("--- output ---");
    expect(jobs.hasRunning).toBe(false);
    await expect(new CodeJobRegistry().inspect([id])).rejects.toThrow();
  } finally {
    await jobs.dispose();
  }
});

it("retains ordered images, failure output and a log independent of the shared response budget", async () => {
  const jobs = new CodeJobRegistry();
  const backend = createLocalToolExecutionBackend();
  const image = {
    type: "image",
    mimeType: "image/png",
    data: (
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
        .png()
        .toBuffer()
    ).toString("base64"),
  };
  const ids = [0, 1].map(() =>
    jobs.start({
      backend,
      cwd: "/workspace",
      source: "inline code",
      signal: signal(),
      program: {
        name: "tau",
        documentation: "test",
        api: { image: () => image },
        code: 'printText("start " + "x".repeat(100000)); await printImage(await tau.image()); printText("end"); throw new Error("diagnostic");',
      },
    }),
  );
  try {
    await jobs.waitForIdle();
    const tools = createJobToolDefinitions(jobs, "code");
    const wait = tools.find((tool) => tool.schema.name === "wait_for_code_jobs");
    const result = await call(wait, { ids, maxOutputTokens: 1000 });
    expect(result.outcome).toBe("succeeded");
    expect(text(result).length).toBeLessThan(10000);
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(2);
    expect(text(result)).toContain("diagnostic");
    expect(text(result)).toContain("output: truncated");
    for (const match of text(result).matchAll(/^text_log: (.+)$/gm)) {
      const log = await readFile(match[1], "utf8");
      expect(log).toContain("start ");
      expect(log).toContain("diagnostic");
      expect(log.length).toBeGreaterThan(100000);
    }
    const full = await jobs.inspect([ids[0]], true, 65536);
    expect(full.content.map((part) => part.type)).toEqual(["text", "text", "image", "text"]);
    expect(full.content[1].text).toContain("start ");
    expect(full.content[3].text).toContain("end");
    const hidden = await call(wait, { ids, includeOutput: false });
    expect(text(hidden)).toContain("status: failed");
    expect(text(hidden)).not.toContain("diagnostic");
    expect(hidden.content.every((part) => part.type === "text")).toBe(true);
    expect((await call(wait, { ids: ["unknown"] })).outcome).toBe("failed");
    expect((await call(wait, { ids, maxOutputTokens: 65537 })).outcome).toBe("blocked");
  } finally {
    await jobs.dispose();
  }
});

it("launches a saved background source and keeps it unchanged after the file is edited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-code-launch-"));
  const jobs = new CodeJobRegistry();
  const bashJobs = new BashJobRegistry();
  const backend = createLocalToolExecutionBackend();
  const tool = createCodeToolDefinition({
    backend,
    cwd: directory,
    config: {},
    allowedTools: ["bash"],
    bashJobs,
    codeJobs: jobs,
  });
  try {
    await writeFile(
      join(directory, "work.js"),
      'await tau.bash.run({ command: "sleep 0.1" }); printText(input.value);',
    );
    const result = await call(tool, {
      file: "work.js",
      input: { value: "original" },
      background: true,
    });
    expect(result.outcome).toBe("succeeded");
    const id = text(result).match(/job ([^ ]+)/)[1];
    await writeFile(join(directory, "work.js"), 'throw new Error("changed");');
    await jobs.waitForIdle();
    const output = await jobs.inspect([id]);
    expect(output.text).toContain("original");
    expect(output.text).not.toContain("changed");
  } finally {
    await jobs.dispose();
    await bashJobs.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reads source and writes captured logs on the supplied execution backend", async () => {
  const source = 'printText("x".repeat(100000));';
  const backend = {
    readFileBinary: vi.fn(async (path) => ({ path, content: Buffer.from(source) })),
    runNodeScript: vi.fn(async () => ({ exitCode: 0, stdout: "/remote/tmp/captured.txt" })),
    writeFile: vi.fn(async (path) => ({ path })),
  };
  const jobs = new CodeJobRegistry();
  const tool = createCodeToolDefinition({
    backend,
    cwd: "/remote/work",
    config: {},
    allowedTools: ["bash"],
    bashJobs: new BashJobRegistry(),
    codeJobs: jobs,
  });
  try {
    const launched = await call(tool, { file: "scripts/report.js", background: true });
    expect(launched.outcome).toBe("succeeded");
    const id = text(launched).match(/job ([^ ]+)/)[1];
    await jobs.waitForIdle();
    const output = await jobs.inspect([id], true, 100);
    expect(backend.readFileBinary).toHaveBeenCalledExactlyOnceWith(
      "/remote/work/scripts/report.js",
      { maxBytes: 1024 * 1024 },
    );
    expect(backend.writeFile).toHaveBeenCalledWith(
      "/remote/tmp/captured.txt",
      `${"x".repeat(100000)}\n`,
    );
    expect(output.text).toContain("text_log: /remote/tmp/captured.txt");
    expect(output.truncated).toBe(true);
  } finally {
    await jobs.dispose();
  }
});

it("bounds capture independently of inspection budgets and reports lost text", async () => {
  const jobs = new CodeJobRegistry();
  const backend = createLocalToolExecutionBackend();
  const id = jobs.start({
    backend,
    cwd: "/workspace",
    source: "inline code",
    signal: signal(),
    program: {
      name: "tau",
      documentation: "test",
      api: { unused: () => null },
      code: 'printText("oldest" + "x".repeat(2 * 1024 * 1024) + "latest");',
    },
  });
  try {
    await jobs.waitForIdle();
    const output = await jobs.inspect([id], true, 65536);
    expect(output.text).toContain("capture: truncated");
    const log = await readFile(output.text.match(/^text_log: (.+)$/m)[1], "utf8");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(1024 * 1024);
    expect(log).not.toContain("oldest");
    expect(log).toContain("latest");
  } finally {
    await jobs.dispose();
  }
});

it("bounds images in combined inspections without discarding retained job images", async () => {
  const jobs = new CodeJobRegistry();
  const backend = createLocalToolExecutionBackend();
  const image = {
    type: "image",
    mimeType: "image/png",
    data: (
      await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } })
        .png()
        .toBuffer()
    ).toString("base64"),
  };
  const ids = [0, 1].map(() =>
    jobs.start({
      backend,
      cwd: "/workspace",
      source: "inline code",
      signal: signal(),
      program: {
        name: "tau",
        documentation: "test",
        api: { image: () => image },
        code: "const image = await tau.image(); for (let i = 0; i < 9; i++) await printImage(image);",
      },
    }),
  );
  try {
    await jobs.waitForIdle();
    const combined = await jobs.inspect(ids);
    expect(combined.content.filter((part) => part.type === "image")).toHaveLength(16);
    expect(combined.truncated).toBe(true);
    for (const id of ids) {
      const individual = await jobs.inspect([id]);
      expect(individual.content.filter((part) => part.type === "image")).toHaveLength(9);
      expect(individual.truncated).toBe(false);
    }
  } finally {
    await jobs.dispose();
  }
});
