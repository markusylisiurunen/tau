import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";
import { createCodeToolDefinition } from "../dist/core/tools/code.js";
import { CodeJobRegistry } from "../dist/core/tools/code_jobs.js";
import {
  createLocalToolExecutionBackend,
  scopeToolExecutionBackend,
} from "../dist/core/tools/execution_backend.js";
import { createProtocolImage } from "./helpers/session_protocol_fixtures.js";

async function withTool(allowedTools, test) {
  const cwd = await mkdtemp(join(tmpdir(), "tau-code-packages-"));
  const bashJobs = new BashJobRegistry();
  const codeJobs = new CodeJobRegistry();
  const backend = scopeToolExecutionBackend(createLocalToolExecutionBackend(), cwd);
  const tool = createCodeToolDefinition({
    backend,
    cwd,
    allowedTools,
    config: {},
    bashJobs,
    codeJobs,
  });
  const run = (code, options = {}) =>
    tool.execute(
      { id: "call", name: "code", arguments: { code, ...options } },
      {
        agentId: "agent",
        assistantMessageId: "message",
        turnId: "turn",
        signal: new AbortController().signal,
        emitActivity: async () => {},
      },
    );
  try {
    await test(run, cwd);
  } finally {
    await codeJobs.dispose();
    await bashJobs.dispose();
    await backend.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

const output = (result) =>
  result.content
    .filter(({ type }) => type === "text")
    .map(({ text }) => text)
    .join("\n");

it("loads only enabled packages and does not expose the Code Mode globals", async () => {
  await withTool(["edit"], async (run, cwd) => {
    const result = await run(`
      import { docs, printText } from "@tau/core";
      import * as files from "@tau/files";
      const summary = [typeof tau, typeof globalThis.input, typeof globalThis.printText,
        typeof files.readText, typeof files.writeText, typeof files.edit];
      try { await files.writeText("denied.txt", "x"); } catch (error) { summary.push(error.code); }
      for (const page of [undefined, "examples", "@tau/files", "@tau/web"]) {
        try { summary.push((await (page === undefined ? docs() : docs(page))).split("\\n")[0]); }
        catch (error) { summary.push(error.code); }
      }
      printText(JSON.stringify(summary));
    `);
    expect(result.outcome).toBe("succeeded");
    expect(JSON.parse(output(result))).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "function",
      "function",
      "function",
      "not_permitted",
      "# Code programs and @tau/core",
      "# Code program examples",
      "# @tau/files",
      "unknown_page",
    ]);
    await expect(readFile(join(cwd, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const code of [
      'import { search } from "@tau/web"; await search("books");',
      'import { run } from "@tau/bash"; await run("true");',
      'import "node:fs";',
      'await import("./helper.js");',
      'const name = "./helper.js"; await import(name);',
    ]) {
      expect((await run(code)).outcome).toBe("failed");
    }
  });
});

it("uses one local module instance for multiple importers and honors the output helpers", async () => {
  await withTool(["bash"], async (run, cwd) => {
    await Promise.all([
      writeFile(join(cwd, "shared.js"), "export let count = 0; export function add() { count++; }"),
      writeFile(
        join(cwd, "a.js"),
        'import { add } from "./shared.js"; await Promise.resolve(); add();',
      ),
      writeFile(join(cwd, "b.js"), 'export { count } from "./shared.js";'),
    ]);
    const result = await run(
      `
      import "./a.js";
      import { count } from "./b.js";
      import { input, printText, truncate } from "@tau/core";
      printText(JSON.stringify([count, truncate(input, { maxChars: 4 }),
        truncate("one\\ntwo\\nthree", { maxLines: 1, keep: "tail" })]));
    `,
      { input: "ab🙂defg" },
    );
    expect(result.outcome).toBe("succeeded");
    expect(JSON.parse(output(result))).toEqual([1, "ab…fg", "…\nthree"]);
  });
});

it("does exact batch edits in one write and passes file bytes directly to image output", async () => {
  await withTool(["bash", "edit", "write"], async (run, cwd) => {
    const image = Buffer.from(createProtocolImage().data, "base64");
    await writeFile(join(cwd, "sample.png"), image);
    const result = await run(`
      import { printText, printImage } from "@tau/core";
      import * as files from "@tau/files";
      const { path } = await files.writeText("reports/test.md", "first\\nsecond\\n");
      try {
        await files.edit(path, [{ oldText: "first", newText: "changed" }, { oldText: "missing", newText: "new" }]);
      } catch (error) { printText(error.code); }
      printText(await files.readText(path));
      await files.edit(path, [{ oldText: "first", newText: "changed" }, { oldText: "changed", newText: "third" }]);
      await files.edit(path, [{ oldText: "second", newText: "fourth" }]);
      const bytes = await files.readBytes("sample.png");
      if (!(bytes instanceof Uint8Array)) throw new Error("Not bytes");
      await files.writeBytes("reports/sample.png", bytes.subarray());
      await printImage(bytes);
    `);
    expect(result.outcome).toBe("succeeded");
    expect(output(result)).toContain("edit_no_match\nfirst\nsecond");
    expect(result.content.at(-1)?.type).toBe("image");
    expect(await readFile(join(cwd, "reports/test.md"), "utf8")).toBe("third\nfourth\n");
    expect(await readFile(join(cwd, "reports/sample.png"))).toEqual(image);
  });
});

it("preserves foreground results, stops overflowing commands, and waits for either Bash job form", async () => {
  await withTool(["bash"], async (run, cwd) => {
    const result = await run(`
      import * as bash from "@tau/bash";
      import { printText } from "@tau/core";
      const text = await bash.text("printf out; printf warn >&2");
      const failed = await bash.run("printf out; printf err >&2; exit 7");
      let exit, overflow;
      try { await bash.text("exit 8"); } catch (error) { exit = [error.code, error.exitCode]; }
      try {
        await bash.run("head -c 25165825 /dev/zero; sleep 4; touch overflow-completed");
      } catch (error) { overflow = error.code; }
      const slow = await bash.start("sleep 10");
      const fast = await bash.start("exit 9");
      const winner = await bash.wait([slow.id, fast.id]);
      const same = await bash.wait(fast.id);
      let timeout;
      try { await bash.wait(slow.id, { timeout: 1 }); } catch (error) { timeout = error.code; }
      const beforeStop = await bash.read(slow.id);
      await bash.stop(slow.id);
      printText(JSON.stringify({ text, failed, exit, overflow, winner: winner.exitCode, same: same.id === winner.id, timeout, running: beforeStop.status }));
    `);
    expect(result.outcome).toBe("succeeded");
    const data = JSON.parse(output(result));
    expect(data).toMatchObject({
      text: "out",
      failed: { stdout: "out", stderr: "err", exitCode: 7 },
      exit: ["command_failed", 8],
      overflow: "output_limit",
      winner: 9,
      same: true,
      timeout: "wait_timeout",
      running: "running",
    });
    expect(data.failed).not.toHaveProperty("truncated");
    await expect(readFile(join(cwd, "overflow-completed"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
