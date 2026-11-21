# @tau/pdf

OCR a PDF into Markdown and page images. Unpack a document once, print its `outputDir`, and read the files in later programs.

```js
import { printText, truncate } from "@tau/core";
import * as files from "@tau/files";
import { unpack } from "@tau/pdf";

const { outputDir, documentPath, pages } = await unpack("specs/report.pdf");
const text = await files.readText(documentPath);
printText(`${outputDir}: ${pages.length} pages\n\n${truncate(text, { maxLines: 200, keep: "head" })}`);
```

## API

```ts
function unpack(path: string, options?: { outputDir?: string }): Promise<Unpacked>;

type Unpacked = {
  outputDir: string;
  documentPath: string; // all pages as one Markdown file
  pages: Array<{
    pageNumber: number; // starts at 1
    markdownPath: string; // this page's Markdown
    patchPaths: string[]; // PNG images of this page, in strips from top to bottom
  }>;
};
```

The PDF can be up to 50 MiB. Paths resolve from the working directory, and the result's paths are absolute. Later programs can find the files by their names in `outputDir`: `document.md`, `pages/page-0001.md`, and `images/page-0001/patch-0001.png`. `outputDir` must not exist yet, and its parent must. Without it, Tau creates a temporary directory that stays until you delete it.

## Reading the output

OCR can contain mistakes. Tables appear inline as Markdown. Figures and other images appear as `[visual-content: …]` placeholders that name the page's image directory. Each page image is a strip of the page, and neighboring strips overlap slightly, so a line cut at the bottom of one strip appears whole in the next.

For a long document, read only the pages you need:

```js
import { printText } from "@tau/core";
import * as files from "@tau/files";
import { unpack } from "@tau/pdf";

const { pages } = await unpack("contract.pdf");
for (const page of pages.filter(({ pageNumber }) => pageNumber >= 3 && pageNumber <= 5)) {
  printText(`## Page ${page.pageNumber}\n${await files.readText(page.markdownPath)}`);
}
```

When a table, figure, or number looks uncertain, check the page images. To see a strip yourself, pass `await files.readBytes(path)` to `printImage` from `@tau/core`. To check a whole page without loading its images into your context, send its Markdown and its `patchPaths` as image parts to `chat` from `@tau/models`, and ask for corrected Markdown.

## Errors

Failures throw with a message. When something unpacking needs is missing, the call fails with `code: "unavailable"`, and the message says what. If processing fails partway, the error names the directory that holds the completed output, so inspect it before calling `unpack` again. Tau does not retry OCR, and a failed call may already have been charged, so calling `unpack` again can be charged again.
