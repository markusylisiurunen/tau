import { basename, join } from "node:path";
import sharp from "sharp";
import { unavailableError } from "../agent/capabilities.js";
import { getMistralApiKey } from "../config/schema.js";
import { type MistralDocumentOcrPage, ocrMistralDocument } from "../utils/mistral_document_ocr.js";
import { describeMediaError } from "./media.js";
import { createDir, createPdfDirectory, type MediaContext, removeTree } from "./target.js";

const RENDER_DIR_NAME = ".rendered-pages";
const PAGE_NAME_WIDTH = 4;
const PDF_RENDER_DPI = 150;

export type PdfPatchRegion = {
  top: number;
  height: number;
};

function formatPageName(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(PAGE_NAME_WIDTH, "0")}`;
}

function formatPatchName(patchNumber: number): string {
  return `patch-${String(patchNumber).padStart(PAGE_NAME_WIDTH, "0")}.png`;
}

export function computePdfPatchRegions(args: {
  pageWidth: number;
  pageHeight: number;
}): PdfPatchRegion[] {
  const patchHeight = Math.max(1, Math.round((args.pageWidth * 3) / 4));
  if (args.pageHeight <= patchHeight) {
    return [{ top: 0, height: args.pageHeight }];
  }

  const stride = Math.max(1, Math.round(patchHeight * 0.9));
  const regions: PdfPatchRegion[] = [];
  let top = 0;

  while (true) {
    const remainingHeight = args.pageHeight - top;
    if (remainingHeight <= patchHeight) {
      regions.push({ top, height: remainingHeight });
      return regions;
    }

    regions.push({ top, height: patchHeight });
    top += stride;
  }
}

function inlinePageTables(page: MistralDocumentOcrPage): string {
  let markdown = page.markdown;

  for (const table of page.tables) {
    const reference = `[${table.id}](${table.id})`;
    markdown = markdown.split(reference).join(table.content);
  }

  return markdown;
}

function buildVisualPlaceholder(args: { imageId: string; pageName: string }): string {
  return `[visual-content: ${args.imageId}] not inlined. inspect images/${args.pageName}/patch-*.png`;
}

function inlinePageVisualReferences(args: {
  markdown: string;
  page: MistralDocumentOcrPage;
  pageName: string;
}): string {
  let markdown = args.markdown;
  const unresolvedImageIds = new Set<string>();

  for (const image of args.page.images) {
    const placeholder = buildVisualPlaceholder({
      imageId: image.id,
      pageName: args.pageName,
    });
    const references = [`![${image.id}](${image.id})`, `[${image.id}](${image.id})`];
    let replaced = false;

    for (const reference of references) {
      if (!markdown.includes(reference)) {
        continue;
      }

      markdown = markdown.split(reference).join(placeholder);
      replaced = true;
    }

    if (!replaced) {
      unresolvedImageIds.add(image.id);
    }
  }

  if (unresolvedImageIds.size === 0) {
    return markdown;
  }

  const unresolvedSummary = [...unresolvedImageIds]
    .map(
      (imageId) =>
        `- [visual-content: ${imageId}] not inlined. inspect images/${args.pageName}/patch-*.png`,
    )
    .join("\n");

  return [
    markdown,
    "",
    "[visual-content] OCR reported embedded image content that is not inlined:",
    unresolvedSummary,
  ].join("\n");
}

export async function unpackPdf(
  path: string,
  outputDir: string | undefined,
  ctx: MediaContext,
  apiKey = getMistralApiKey(ctx.config),
) {
  if (!apiKey)
    throw unavailableError("PDF unpacking", "MISTRAL_API_KEY or apiKeys.mistral is not configured");
  const input = await ctx.backend.readFileBinary(path, { maxBytes: 50 * 1024 * 1024 });
  const renderPages = async (args: string[]) => {
    const result = await ctx.backend.runBash('exec pdftoppm "$@"', {
      args: ["pdftoppm", ...args],
      signal: ctx.signal,
      timeoutMs: 600000,
    });
    if (result.exitCode === 127)
      throw unavailableError("PDF unpacking", "pdftoppm from Poppler is not installed on PATH");
    if (result.exitCode !== 0 || result.timedOut || result.aborted)
      throw new Error(result.stderr || "pdftoppm failed");
  };

  const dir = await createPdfDirectory(ctx, outputDir);
  const render = join(dir, RENDER_DIR_NAME);
  let ocr: Awaited<ReturnType<typeof ocrMistralDocument>> | undefined;
  try {
    await createDir(ctx, render);
    const source = join(render, "input.pdf");
    await ctx.backend.writeFileBinary(source, input.content);
    await renderPages(["-r", String(PDF_RENDER_DPI), "-png", source, join(render, "page")]);
    const rendered = (await ctx.backend.listDir(render)).entries
      .map((e) => e.name)
      .filter((n) => /^page-\d+\.png$/.test(n))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    ocr = await ocrMistralDocument({
      apiKey,
      document: input.content,
      fileName: basename(path),
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    await ctx.backend.writeFile(join(dir, "ocr.json"), JSON.stringify(ocr.pages));
    const pages = [];
    const texts = [];
    for (const [i, page] of ocr.pages.entries()) {
      ctx.signal.throwIfAborted();
      const name = formatPageName(i + 1);
      const markdown = inlinePageVisualReferences({
        page,
        pageName: name,
        markdown: inlinePageTables(page),
      });
      texts.push(markdown);
      const markdownPath = join(dir, "pages", `${name}.md`);
      await ctx.backend.writeFile(markdownPath, markdown);
      pages.push({ pageNumber: i + 1, markdownPath, patchPaths: [] as string[] });
    }
    if (rendered.length !== ocr.pages.length)
      throw new Error("OCR and rendered page counts differ");
    for (const [i, { patchPaths }] of pages.entries()) {
      ctx.signal.throwIfAborted();
      const name = formatPageName(i + 1);
      const bytes = (
        await ctx.backend.readFileBinary(join(render, rendered[i]!), {
          maxBytes: 128 * 1024 * 1024,
        })
      ).content;
      const { width, height } = await sharp(bytes).metadata();

      for (const [j, region] of computePdfPatchRegions({
        pageWidth: width,
        pageHeight: height,
      }).entries()) {
        ctx.signal.throwIfAborted();
        const patch = join(dir, "images", name, formatPatchName(j + 1));
        await ctx.backend.writeFileBinary(
          patch,
          await sharp(bytes)
            .extract({ left: 0, width, ...region })
            .png()
            .toBuffer(),
        );
        patchPaths.push(patch);
      }
    }
    ctx.signal.throwIfAborted();
    const documentPath = join(dir, "document.md");
    await ctx.backend.writeFile(documentPath, texts.join("\n\n"));
    await removeTree(ctx, render);
    return {
      outputDir: dir,
      documentPath,
      pages,
      ...(ocr.cleanupWarning ? { cleanupWarning: ocr.cleanupWarning } : {}),
    };
  } catch (error) {
    if (ocr)
      throw new Error(
        `PDF output incomplete: ${describeMediaError(error)}; inspect ${dir} for ocr.json and completed pages${ocr.cleanupWarning ? `; ${ocr.cleanupWarning}` : ""}`,
      );
    try {
      await removeTree({ ...ctx, signal: AbortSignal.timeout(10000) }, dir);
    } catch (cleanup) {
      throw new Error(
        `PDF unpack failed: ${describeMediaError(error)}; inspect partial output at ${dir}: ${describeMediaError(cleanup)}`,
      );
    }
    throw error;
  }
}
