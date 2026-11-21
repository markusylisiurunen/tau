# PDF unpacking

`tau tool pdf-unpack` turns a PDF into OCR Markdown and page images. In a session, the agent uses `@tau/pdf` in [code mode](code-mode.md) instead, which reads the key on the host and runs `pdftoppm` where the agent's commands run.

## Credentials and requirements

Needs `MISTRAL_API_KEY` or `apiKeys.mistral`, and `pdftoppm` from Poppler (`brew install poppler` or `apt install poppler-utils`).

## Input and examples

```bash
tau tool pdf-unpack './docs/design review.pdf'
```

The PDF is uploaded to Mistral and deleted afterwards when possible.

## Outputs and recovery

Stdout is one JSON object with `outputDir`, `documentPath`, and a `pages` list of each page's Markdown and image paths. The output directory is temporary and kept until you delete it:

- `document.md`: the whole document
- `pages/page-0001.md`: one file per page
- `images/page-0001/patch-0001.png`: page images for checking uncertain OCR

OCR can contain mistakes, and figures appear as placeholders pointing to page images. If processing fails after OCR, inspect the reported directory for `ocr.json` and any completed Markdown and images before paying for another request.
