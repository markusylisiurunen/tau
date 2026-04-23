import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computePdfPatchRegions, runPdfUnpackCommand } from "../dist/core/tool/pdf_unpack.js";

function createSpawnResult() {
  return {
    stdout: "",
    stderr: "",
    output: "",
    exitCode: 0,
    captureLimitExceeded: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-tool-cli-test-"));
  const inputPdfPath = join(root, "input.pdf");
  await writeFile(inputPdfPath, Buffer.from("%PDF-1.4\n%fake\n"));
  return {
    root,
    inputPdfPath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createRenderSpawnMock(pageSizes) {
  return vi.fn(async (_command, args) => {
    if (args[0] === "-v") {
      return createSpawnResult();
    }

    expect(args).toEqual(expect.arrayContaining(["-r", "150", "-png"]));

    const outputPrefix = args.at(-1);
    for (const [index, page] of pageSizes.entries()) {
      await sharp({
        create: {
          width: page.width,
          height: page.height,
          channels: 3,
          background: { r: 20 + index, g: 40 + index, b: 60 + index },
        },
      })
        .png()
        .toFile(`${outputPrefix}-${index + 1}.png`);
    }

    return createSpawnResult();
  });
}

describe("pdf-unpack", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns one patch for pages shorter than the target 4:3 height", () => {
    expect(computePdfPatchRegions({ pageWidth: 400, pageHeight: 250 })).toEqual([
      { top: 0, height: 250 },
    ]);
  });

  it("uses a shorter trailing patch instead of bottom-anchoring a full-height patch", () => {
    expect(computePdfPatchRegions({ pageWidth: 400, pageHeight: 700 })).toEqual([
      { top: 0, height: 300 },
      { top: 270, height: 300 },
      { top: 540, height: 160 },
    ]);
  });

  it("fails fast when pdftoppm is missing", async () => {
    const fixture = await createFixture();

    try {
      const spawnImpl = vi.fn(async () => {
        const error = new Error("spawn pdftoppm ENOENT");
        error.code = "ENOENT";
        throw error;
      });

      await expect(
        runPdfUnpackCommand([fixture.inputPdfPath], {
          config: { apiKeys: { mistral: "mistral-key" } },
          cwd: fixture.root,
          env: {},
          stdout: () => {},
          spawnImpl,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("pdftoppm not found. install Poppler"),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("cleans up the temp output directory when pdf-unpack fails", async () => {
    const fixture = await createFixture();
    const outputDir = join(fixture.root, "output");

    try {
      await expect(
        runPdfUnpackCommand([fixture.inputPdfPath], {
          config: { apiKeys: { mistral: "mistral-key" } },
          cwd: fixture.root,
          env: {},
          stdout: () => {},
          mkdtempImpl: async () => {
            await mkdir(outputDir, { recursive: true });
            return outputDir;
          },
          ocrImpl: async () => {
            throw new Error("Service unavailable.");
          },
          spawnImpl: createRenderSpawnMock([{ width: 400, height: 300 }]),
        }),
      ).rejects.toMatchObject({
        message: "pdf-unpack failed: Service unavailable.",
        helpPrinter: undefined,
      });

      await expect(access(outputDir)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes markdown and image artifacts on success", async () => {
    const fixture = await createFixture();
    const outputDir = join(fixture.root, "output");
    const stdout = vi.fn();

    try {
      await runPdfUnpackCommand([fixture.inputPdfPath], {
        config: { apiKeys: { mistral: "mistral-key" } },
        cwd: fixture.root,
        env: {},
        stdout,
        mkdtempImpl: async () => {
          await mkdir(outputDir, { recursive: true });
          return outputDir;
        },
        ocrImpl: async () => ({
          pages: [
            {
              markdown: "# page 1\n\n[tbl-0.md](tbl-0.md)",
              tables: [{ id: "tbl-0.md", content: "| a | b |", format: "markdown" }],
              images: [],
            },
            {
              markdown: "# page 2\n\n[tbl-1.md](tbl-1.md)\n\n[img-1.jpeg](img-1.jpeg)",
              tables: [{ id: "tbl-1.md", content: "| c | d |", format: "markdown" }],
              images: [{ id: "img-1.jpeg" }],
            },
          ],
          cleanupWarning: "failed to delete the uploaded PDF from Mistral: Unauthorized",
        }),
        spawnImpl: createRenderSpawnMock([
          { width: 400, height: 300 },
          { width: 400, height: 700 },
        ]),
      });

      expect(stdout).toHaveBeenCalledTimes(1);
      const outputText = stdout.mock.calls[0][0];
      expect(outputText).toContain(`PDF unpacked from: ${fixture.inputPdfPath}`);
      expect(outputText).toContain(`- ${outputDir}`);
      expect(outputText).toContain("Paths below are relative to the output directory.");
      expect(outputText).toContain("- document.md: full document markdown with tables inlined");
      expect(outputText).toContain("- markdown may include [visual-content: ...] placeholders");
      expect(outputText).toContain("Warning:");
      expect(outputText).toContain("- failed to delete the uploaded PDF from Mistral: Unauthorized");
      expect(outputText).toContain("- page markdown files: 2");
      expect(outputText).toContain("- image patch files: 4");
      expect(outputText).toContain("- images/page-0002/patch-0003.png");

      expect(await readFile(join(outputDir, "document.md"), "utf8")).toBe(
        "# page 1\n\n| a | b |\n\n# page 2\n\n| c | d |\n\n[visual-content: img-1.jpeg] not inlined. inspect images/page-0002/patch-*.png",
      );
      expect(await readFile(join(outputDir, "pages", "page-0002.md"), "utf8")).toBe(
        "# page 2\n\n| c | d |\n\n[visual-content: img-1.jpeg] not inlined. inspect images/page-0002/patch-*.png",
      );

      expect(await readdir(join(outputDir, "images", "page-0001"))).toEqual(["patch-0001.png"]);
      expect(await readdir(join(outputDir, "images", "page-0002"))).toEqual([
        "patch-0001.png",
        "patch-0002.png",
        "patch-0003.png",
      ]);
      await expect(readFile(join(outputDir, ".rendered-pages", "page-1.png"))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});
