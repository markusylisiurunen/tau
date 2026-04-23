import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import sharp from "sharp";
import type { Config } from "../config/schema.js";
import { getMistralApiKey } from "../config/schema.js";
import {
  type MistralDocumentOcrPage,
  type MistralDocumentOcrResult,
  ocrMistralDocument,
} from "../utils/mistral_document_ocr.js";
import { type SpawnCaptureResult, spawnWithCapture } from "../utils/spawn_capture.js";
import { ToolCliError } from "./errors.js";

const OUTPUT_DIR_PREFIX = "tau-pdf-unpack-";
const RENDER_DIR_NAME = ".rendered-pages";
const PAGE_NAME_WIDTH = 4;
const PDF_RENDER_DPI = 150;

export type PdfPatchRegion = {
  top: number;
  height: number;
};

export type RunPdfUnpackCommandOptions = {
  config: Config;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawnWithCapture;
  mkdtempImpl?: typeof mkdtemp;
  ocrImpl?: (args: {
    apiKey: string;
    document: Buffer;
    fileName: string;
    fetchImpl?: typeof fetch;
  }) => Promise<MistralDocumentOcrResult>;
};

type ParsedPdfUnpackArgs = {
  help: boolean;
  inputPath?: string;
};

function parsePdfUnpackArgs(argv: string[]): ParsedPdfUnpackArgs {
  let help = false;
  let inputPath: string | undefined;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new ToolCliError(`unknown option: ${arg}`, { helpPrinter: printPdfUnpackHelp });
    }

    if (inputPath !== undefined) {
      throw new ToolCliError(`unexpected argument: ${arg}`, { helpPrinter: printPdfUnpackHelp });
    }

    inputPath = arg;
  }

  return {
    help,
    inputPath,
  };
}

function formatPageName(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(PAGE_NAME_WIDTH, "0")}`;
}

function formatPatchName(patchNumber: number): string {
  return `patch-${String(patchNumber).padStart(PAGE_NAME_WIDTH, "0")}.png`;
}

function formatSpawnFailure(command: string, result: SpawnCaptureResult): string {
  const detail = result.output?.trim() || result.stderr.trim() || result.stdout.trim();
  if (detail) {
    return `${command} failed: ${detail}`;
  }

  if (result.exitCode !== null) {
    return `${command} exited with code ${result.exitCode}`;
  }

  if (result.closeSignal) {
    return `${command} terminated by signal ${result.closeSignal}`;
  }

  if (result.timedOut) {
    return `${command} timed out`;
  }

  return `${command} failed`;
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

export function printPdfUnpackHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau tool pdf-unpack <file.pdf>",
      "",
      "options:",
      "  --help  show this help and exit.",
      "",
      "artifacts:",
      "  writes a persistent temp directory containing document.md, pages/, and images/.",
      "",
      "notes:",
      "  requires pdftoppm from Poppler on PATH.",
      "  requires apiKeys.mistral or MISTRAL_API_KEY for OCR.",
      "  keeps the output directory on disk for follow-up model use.",
    ].join("\n"),
  );
}

async function resolveInputPdfPath(inputPath: string, cwd: string): Promise<string> {
  const resolvedPath = resolve(cwd, inputPath);

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(resolvedPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ToolCliError(`pdf not found: ${resolvedPath}`, { helpPrinter: printPdfUnpackHelp });
    }
    throw error;
  }

  if (!fileStat.isFile()) {
    throw new ToolCliError(`pdf is not a file: ${resolvedPath}`, {
      helpPrinter: printPdfUnpackHelp,
    });
  }

  try {
    await access(resolvedPath, fsConstants.R_OK);
  } catch {
    throw new ToolCliError(`pdf is not readable: ${resolvedPath}`, {
      helpPrinter: printPdfUnpackHelp,
    });
  }

  return resolvedPath;
}

async function assertPdftoppmAvailable(args: {
  cwd: string;
  spawnImpl: typeof spawnWithCapture;
}): Promise<void> {
  try {
    const result = await args.spawnImpl("pdftoppm", ["-v"], {
      cwd: args.cwd,
      captureOutput: "combined",
    });
    if (result.exitCode === 0) {
      return;
    }

    throw new ToolCliError(formatSpawnFailure("pdftoppm", result), {
      helpPrinter: printPdfUnpackHelp,
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ToolCliError(
        "pdftoppm not found. install Poppler and ensure pdftoppm is on PATH (macOS: brew install poppler, Linux: apt install poppler-utils).",
        { helpPrinter: printPdfUnpackHelp },
      );
    }

    throw error;
  }
}

async function renderPdfPages(args: {
  inputPath: string;
  renderDir: string;
  cwd: string;
  spawnImpl: typeof spawnWithCapture;
}): Promise<string[]> {
  const outputPrefix = join(args.renderDir, "page");
  const result = await args.spawnImpl(
    "pdftoppm",
    ["-r", String(PDF_RENDER_DPI), "-png", args.inputPath, outputPrefix],
    {
      cwd: args.cwd,
      captureOutput: "combined",
    },
  );

  if (result.exitCode !== 0) {
    throw new ToolCliError(formatSpawnFailure("pdftoppm", result), {
      helpPrinter: printPdfUnpackHelp,
    });
  }

  const files = await readdir(args.renderDir);
  const renderedPages = files
    .map((fileName) => {
      const match = /^page-(\d+)\.png$/.exec(fileName);
      if (!match) {
        return undefined;
      }

      return {
        fileName,
        pageNumber: Number(match[1]),
      };
    })
    .filter((entry): entry is { fileName: string; pageNumber: number } => entry !== undefined)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((entry) => join(args.renderDir, entry.fileName));

  if (renderedPages.length === 0) {
    throw new ToolCliError("pdftoppm did not produce any page renders", {
      helpPrinter: printPdfUnpackHelp,
    });
  }

  return renderedPages;
}

async function writePatchImages(args: {
  renderedPagePaths: string[];
  imagesDir: string;
}): Promise<number> {
  let patchCount = 0;

  for (const [index, renderedPagePath] of args.renderedPagePaths.entries()) {
    const pageNumber = index + 1;
    const pageName = formatPageName(pageNumber);
    const pageImagesDir = join(args.imagesDir, pageName);
    await mkdir(pageImagesDir, { recursive: true });

    const image = sharp(renderedPagePath);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    if (!width || !height) {
      throw new ToolCliError(`failed to inspect rendered page image: ${renderedPagePath}`, {
        helpPrinter: printPdfUnpackHelp,
      });
    }

    const patchRegions = computePdfPatchRegions({
      pageWidth: width,
      pageHeight: height,
    });

    for (const [patchIndex, patchRegion] of patchRegions.entries()) {
      const patchPath = join(pageImagesDir, formatPatchName(patchIndex + 1));
      await sharp(renderedPagePath)
        .extract({
          left: 0,
          top: patchRegion.top,
          width,
          height: patchRegion.height,
        })
        .png()
        .toFile(patchPath);
      patchCount += 1;
    }
  }

  return patchCount;
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

function buildDocumentMarkdown(pages: string[]): string {
  return pages.join("\n\n");
}

async function collectOutputFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const filePaths: string[] = [];

  for (const entry of sortedEntries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await collectOutputFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function buildOutputSummary(args: {
  inputPath: string;
  outputDir: string;
  documentPath: string;
  pagesDir: string;
  imagesDir: string;
  pageCount: number;
  patchCount: number;
  outputFiles: string[];
  cleanupWarning?: string;
}): string {
  const relativePath = (filePath: string): string => relative(args.outputDir, filePath) || ".";

  return [
    `PDF unpacked from: ${args.inputPath}`,
    "",
    "Output directory:",
    `- ${args.outputDir}`,
    "",
    "Paths below are relative to the output directory.",
    "",
    "What is in the output:",
    `- ${relativePath(args.documentPath)}: full document markdown with tables inlined`,
    `- ${relativePath(args.pagesDir)}/: one markdown file per PDF page, with tables inlined`,
    `- ${relativePath(args.imagesDir)}/: page image patches grouped by page number`,
    "",
    "How the image patches were generated:",
    "- each patch uses the full rendered page width",
    "- patches target a 4:3 aspect ratio when possible",
    "- patches move downward with about 10% vertical overlap",
    "- if the bottom of a page does not fill another 4:3 patch, the final patch is shorter and covers the remaining page content",
    "",
    "How to inspect it:",
    `- read ${relativePath(args.documentPath)} first if you want the whole document in one file`,
    `- read files under ${relativePath(args.pagesDir)}/ if you want page-by-page markdown`,
    "- the markdown was produced with OCR, so it may contain typos or other recognition mistakes",
    "- markdown may include [visual-content: ...] placeholders where OCR detected embedded image content",
    `- treat files under ${relativePath(args.imagesDir)}/ as the most reliable source because they match the original PDF page content exactly`,
    `- inspect files under ${relativePath(args.imagesDir)}/ when you need to verify or correct anything in the markdown`,
    ...(args.cleanupWarning
      ? ["", "Warning:", `- ${args.cleanupWarning}`]
      : []),
    "",
    "Artifact summary:",
    `- page markdown files: ${args.pageCount}`,
    `- image patch files: ${args.patchCount}`,
    "",
    "All output files:",
    ...args.outputFiles.map((filePath) => `- ${relativePath(filePath)}`),
  ].join("\n");
}

export async function runPdfUnpackCommand(
  argv: string[],
  options: RunPdfUnpackCommandOptions,
): Promise<void> {
  const parsed = parsePdfUnpackArgs(argv);
  if (parsed.help) {
    printPdfUnpackHelp();
    return;
  }

  if (!parsed.inputPath) {
    throw new ToolCliError("missing PDF path", { helpPrinter: printPdfUnpackHelp });
  }

  const stdout = options.stdout ?? console.log;
  const cwd = options.cwd ?? process.cwd();
  const spawnImpl = options.spawnImpl ?? spawnWithCapture;
  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const pdfPath = await resolveInputPdfPath(parsed.inputPath, cwd);
  const apiKey = getMistralApiKey(options.config, options.env);
  if (!apiKey) {
    throw new ToolCliError(
      "missing Mistral API key. set MISTRAL_API_KEY or config apiKeys.mistral",
      { helpPrinter: printPdfUnpackHelp },
    );
  }

  await assertPdftoppmAvailable({ cwd, spawnImpl });

  let outputDir: string | undefined;

  try {
    outputDir = resolve(await mkdtempImpl(join(tmpdir(), OUTPUT_DIR_PREFIX)));
    const pagesDir = join(outputDir, "pages");
    const imagesDir = join(outputDir, "images");
    const renderDir = join(outputDir, RENDER_DIR_NAME);
    const documentPath = join(outputDir, "document.md");
    await mkdir(pagesDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await mkdir(renderDir, { recursive: true });

    const documentBuffer = await readFile(pdfPath);
    const ocrImpl = options.ocrImpl ?? ocrMistralDocument;
    const ocrResult = await ocrImpl({
      apiKey,
      document: documentBuffer,
      fileName: basename(pdfPath),
      fetchImpl: options.fetchImpl,
    });
    const ocrPages = ocrResult.pages;
    const renderedPagePaths = await renderPdfPages({
      inputPath: pdfPath,
      renderDir,
      cwd,
      spawnImpl,
    });

    if (ocrPages.length !== renderedPagePaths.length) {
      throw new ToolCliError(
        `Mistral OCR returned ${ocrPages.length} pages, but pdftoppm rendered ${renderedPagePaths.length}`,
        { helpPrinter: printPdfUnpackHelp },
      );
    }

    const inlinedPages = ocrPages.map((page, index) => {
      const pageName = formatPageName(index + 1);
      const markdownWithTables = inlinePageTables(page);
      return inlinePageVisualReferences({
        markdown: markdownWithTables,
        page,
        pageName,
      });
    });
    for (const [index, pageMarkdown] of inlinedPages.entries()) {
      const pagePath = join(pagesDir, `${formatPageName(index + 1)}.md`);
      await writeFile(pagePath, pageMarkdown, "utf8");
    }

    await writeFile(documentPath, buildDocumentMarkdown(inlinedPages), "utf8");
    const patchCount = await writePatchImages({
      renderedPagePaths,
      imagesDir,
    });
    await rm(renderDir, { recursive: true, force: true });

    const outputFiles = await collectOutputFiles(outputDir);
    stdout(
      buildOutputSummary({
        inputPath: pdfPath,
        outputDir,
        documentPath,
        pagesDir,
        imagesDir,
        pageCount: inlinedPages.length,
        patchCount,
        outputFiles,
        cleanupWarning: ocrResult.cleanupWarning,
      }),
    );
  } catch (error) {
    if (outputDir) {
      try {
        await rm(outputDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures and preserve the original error
      }
    }

    if (error instanceof ToolCliError) {
      throw error;
    }

    throw new ToolCliError(
      `pdf-unpack failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
