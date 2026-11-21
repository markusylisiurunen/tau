# @tau/pdf

OCR a PDF into Markdown and page images. Unpack a document once, print its `outputDir`, and read the files in later programs, because every `unpack` call is a new paid OCR request.

```js
import { printText, truncate } from "@tau/core";
import * as files from "@tau/files";
import { unpack } from "@tau/pdf";

const { outputDir, documentPath, pages } = await unpack("specs/design review.pdf");
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
  cleanupWarning?: string; // set when the uploaded copy could not be deleted
};
```

Paths resolve from the working directory, and the result's paths are absolute. Later programs can find the files by their names in `outputDir`: `document.md`, `pages/page-0001.md`, and `images/page-0001/patch-0001.png`. `outputDir` must not exist yet, and its parent must. Without it, Tau creates a temporary directory that stays until you delete it. If processing fails after OCR, inspect the reported directory for `ocr.json` and any completed Markdown and images before paying for another request.

The PDF can be up to 50 MiB. Tau uploads it to Mistral for OCR and deletes the uploaded copy afterwards when it can. Unpacking needs a Mistral key and `pdftoppm` from Poppler on the Bash `PATH`.

## Reading the output

OCR can contain mistakes. Tables appear inline as Markdown. Figures and other images appear as `[visual-content: …]` placeholders that name the page's image directory. Each page image is a strip of the page rendered at 150 DPI, and neighboring strips overlap slightly, so a line cut at the bottom of one strip appears whole in the next.

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

When a table, figure, or number looks uncertain, check the page images. To see a strip yourself, pass `await files.readBytes(path)` to `printImage` from `@tau/core`. To check a whole page without loading its images into your context, ask a model to compare the OCR with the page:

```js
import { input, printText } from "@tau/core";
import * as files from "@tau/files";
import { chat, list } from "@tau/models";

const page = input.page; // one entry of pages from an earlier unpack
const { chat: models } = await list();
const model = models.find(({ inputs }) => inputs.includes("image"));
if (!model) throw new Error("No image model available");
const result = await chat([{ role: "user", content: [
  { type: "text", text: `Correct this OCR of the pictured page. Reply with the corrected Markdown only.\n\n${await files.readText(page.markdownPath)}` },
  ...page.patchPaths.map((path) => ({ type: "image", path })),
] }], { model: model.id });
printText(result.answer ?? result.status);
```

## Errors

Failures throw with a message, for example when the Mistral key or `pdftoppm` is missing or OCR fails. Tau does not retry OCR, and calling `unpack` again is charged again.
