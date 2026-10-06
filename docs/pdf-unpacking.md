# PDF unpacking

`tau tool pdf-unpack` turns a PDF into OCR Markdown and page-image patches using Mistral and Poppler.

```bash
tau tool pdf-unpack --help
tau tool pdf-unpack ./docs/architecture.pdf
```

## Credentials and requirements

Requires a Mistral API key. See [feature-specific credentials](credentials.md#feature-specific-keys) for setup.

The command requires `pdftoppm` from Poppler on `PATH`. On macOS, install it with `brew install poppler`; Debian-based Linux distributions provide it through `apt install poppler-utils`.

## Input and examples

Give one local PDF path, relative to the current directory. Quote paths containing spaces:

```bash
tau tool pdf-unpack './docs/design review.pdf'
```

The command uploads the PDF to Mistral for OCR and renders page images locally. Use it for a sensitive document only if you may send it to Mistral and keep the extracted files locally.

## Outputs and recovery

On success, stdout prints the output directory, which is temporary but not deleted automatically, and lists every file. The directory contains:

- `document.md`: the complete OCR document with recognized tables inlined.
- `pages/page-0001.md` and later numbered files: one Markdown file per PDF page.
- `images/page-0001/patch-0001.png` and later numbered patches: images for visual verification.

OCR text can contain mistakes. Images and figures that are not captured in Markdown are marked with placeholders that point to the matching page patches. Read `document.md` for the whole document, use `pages/` for page-level work, and inspect `images/` before trusting or correcting uncertain OCR.

After OCR, the command tries to delete the uploaded file from Mistral and reports if that fails. The local output stays on disk; delete it when you no longer need it. If processing fails, Tau tries to remove the partial output directory. The error names the step that failed and says whether the partial output was removed. Partial output is never a complete result. If the failure happens after the OCR request started, the error warns that running the command again may be charged again.

See [command-line tools](tools.md) for the other tools and where commands run.
