import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeTauCodeMode } from "../dist/code_mode/index.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

const roots = new Set();
const outsidePaths = new Set();

function createDefinition(name = "fixture") {
  return {
    name,
    documentation: `# ${name} API`,
    api: { echo: async ([value]) => value },
  };
}

function createFiles(agentId = randomUUID()) {
  const backend = createLocalToolExecutionBackend();
  return {
    agentId,
    adapter: {
      runNodeScript: (script, options) =>
        backend.runNodeScript(script, [], {
          stdin: Buffer.from(options.input),
          signal: options.signal,
          maxCaptureBytes: options.maxCaptureBytes,
        }),
    },
  };
}

async function run(code, files, name) {
  return await executeTauCodeMode({
    ...createDefinition(name),
    code,
    files,
  });
}

function parseOutput(result) {
  return JSON.parse(result.content);
}

function rememberRoot(path) {
  const root = dirname(path);
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  for (const path of outsidePaths) rmSync(path, { force: true });
  roots.clear();
  outsidePaths.clear();
});

describe("code-mode scratch files", () => {
  it("shares real files across code-mode tools and later executions", async () => {
    const files = createFiles();
    const docs = await run("console.log(docs)", files);
    expect(docs.content).toContain("- `files`: shared UTF-8 scratch files for this agent");
    expect(docs.content).toContain("## Scratch files");

    const written = parseOutput(
      await run(
        'console.log(await files.write("results.json", JSON.stringify([1, 2, 3])))',
        files,
        "first",
      ),
    );
    const root = rememberRoot(written.path);

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(written.path).mode & 0o777).toBe(0o600);
    expect(written.bytes).toBe(7);
    expect(readFileSync(written.path, "utf8")).toBe("[1,2,3]");
    writeFileSync(written.path, "changed by bash");

    await expect(
      run('console.log(await files.read("results.json"))', files, "second"),
    ).resolves.toEqual({ content: "changed by bash" });
    const listed = parseOutput(await run("console.log(await files.list())", files, "third"));
    expect(listed).toEqual({
      files: [{ name: "results.json", path: written.path, bytes: 15 }],
      totalFiles: 1,
      totalBytes: 15,
    });

    await run('console.log(await files.remove("results.json"))', files, "fourth");
    expect(existsSync(written.path)).toBe(false);
  });

  it("isolates agents and rejects paths and symlinks", async () => {
    const firstFiles = createFiles("agent-a");
    const secondFiles = createFiles("agent-b");
    const first = parseOutput(
      await run('console.log(await files.write("shared.txt", "first"))', firstFiles),
    );
    const second = parseOutput(
      await run('console.log(await files.write("shared.txt", "second"))', secondFiles),
    );
    const firstRoot = rememberRoot(first.path);
    rememberRoot(second.path);

    expect(first.path).not.toBe(second.path);
    await expect(run('await files.write("../escape", "no")', firstFiles)).rejects.toThrow(
      "scratch file name must be a UTF-8 basename",
    );

    const outsidePath = join(tmpdir(), `tau-code-mode-files-test-${randomUUID()}`);
    outsidePaths.add(outsidePath);
    writeFileSync(outsidePath, "outside");
    symlinkSync(outsidePath, join(firstRoot, "link.txt"));

    await expect(run('await files.read("link.txt")', firstFiles)).rejects.toThrow("ELOOP");
  });

  it("enforces the per-agent file count and total size quotas", async () => {
    const countFiles = createFiles();
    const countSeed = parseOutput(
      await run('console.log(await files.write("0.txt", "x"))', countFiles),
    );
    const countRoot = rememberRoot(countSeed.path);
    for (let index = 1; index < 128; index += 1) {
      writeFileSync(join(countRoot, `${index}.txt`), "x");
    }

    await expect(run('await files.write("overflow.txt", "x")', countFiles)).rejects.toThrow(
      "scratch directory exceeds the 128-file limit",
    );
    await run('console.log(await files.remove("127.txt"))', countFiles);
    await expect(
      run('console.log(await files.write("replacement.txt", "x"))', countFiles),
    ).resolves.toEqual({
      content: expect.stringContaining('"bytes":1'),
    });

    const sizeFiles = createFiles();
    const sizeSeed = parseOutput(
      await run('console.log(await files.write("large.bin", "x"))', sizeFiles),
    );
    rememberRoot(sizeSeed.path);
    truncateSync(sizeSeed.path, 64 * 1024 * 1024);

    await expect(run('await files.write("overflow.txt", "x")', sizeFiles)).rejects.toThrow(
      "scratch directory exceeds the 64 MiB total limit",
    );
  });
});
