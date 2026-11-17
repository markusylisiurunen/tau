import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTextToClipboard } from "../dist/tui/clipboard.js";

// Fake providers on PATH exercise real process spawning, stdin delivery, and exit handling.
describe("copyTextToClipboard", () => {
  const originalPath = process.env.PATH;
  let bin;

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "tau-clipboard-bin-"));
    process.env.PATH = bin;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(bin, { recursive: true, force: true });
  });

  async function provider(name, script) {
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, name), 0o755);
  }

  it("falls through missing and failing providers to one that receives the text", async () => {
    const output = join(bin, "clipboard.txt");
    // wl-copy is missing, xclip fails, and xsel or pbcopy receives the text.
    await provider("xclip", "echo 'cannot open display' >&2; exit 1");
    await provider("xsel", `exec /bin/cat > '${output}'`);
    await provider("pbcopy", `exec /bin/cat > '${output}'`);

    await copyTextToClipboard("hello\nclipboard");

    expect(await readFile(output, "utf8")).toBe("hello\nclipboard");
  });

  it("rejects when every provider is missing or fails", async () => {
    await provider("xclip", "exit 1");

    await expect(copyTextToClipboard("hello")).rejects.toThrow();
  });
});
