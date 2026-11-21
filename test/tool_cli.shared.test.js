import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTauCodeMode } from "../dist/code_mode/runtime.js";
import { createFilesPackage } from "../dist/core/code_mode/files.js";
import { createPdfPackage } from "../dist/core/code_mode/pdf.js";
import { computePdfPatchRegions } from "../dist/core/media/pdf.js";
import {
  createLocalToolExecutionBackend,
  scopeToolExecutionBackend,
} from "../dist/core/tools/execution_backend.js";

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

  it.each([false, true])("keeps OCR readable with a damaged render: %s", async (damaged) => {
    const root = await mkdtemp(join(tmpdir(), "tau-pdf-test-"));
    const backend = scopeToolExecutionBackend(createLocalToolExecutionBackend(), root);
    try {
      await backend.writeFile("input.pdf", "test PDF");
      vi.spyOn(backend, "runBash").mockImplementation(async (_command, { args }) => {
        if (damaged) await backend.writeFile(`${args.at(-1)}-1.png`, "invalid");
        else
          await sharp({ create: { width: 200, height: 300, channels: 3, background: "white" } })
            .png()
            .toFile(`${args.at(-1)}-1.png`);
        return { exitCode: 0 };
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ id: "12345678-1111-4111-8111-123456789abc" }))
          .mockResolvedValueOnce(
            Response.json({
              pages: [
                {
                  index: 0,
                  markdown: "[tbl](tbl)",
                  tables: [{ id: "tbl", format: "markdown", content: "table text" }],
                },
              ],
            }),
          )
          .mockResolvedValueOnce(new Response(null, { status: 204 })),
      );
      const result = await runTauCodeMode({
        packages: [
          createPdfPackage(backend, { apiKeys: { mistral: "test" } }),
          createFilesPackage(backend),
        ],
        timeoutMs: 60000,
        code: `import {unpack} from '@tau/pdf';import * as f from '@tau/files';import {printText} from '@tau/core';const r=await unpack('input.pdf',{outputDir:'ocr'});printText([await f.readText(r.documentPath),r.pages[0].pageNumber,await f.readText(r.pages[0].markdownPath),(await f.readBytes(r.pages[0].patchPaths[0]))[0]].join('/'));`,
      });
      if (damaged) {
        expect((await backend.readFile("ocr/pages/page-0001.md")).content).toBe("table text");
        expect(JSON.parse((await backend.readFile("ocr/ocr.json")).content)[0].markdown).toBe(
          "[tbl](tbl)",
        );
        await expect(backend.readFile("ocr/document.md")).rejects.toThrow();
      } else expect(result.result.content[0].text).toBe("table text/1/table text/137");
    } finally {
      vi.unstubAllGlobals();
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
