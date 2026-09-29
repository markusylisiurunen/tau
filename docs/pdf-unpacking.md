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

Supply one readable local PDF path, resolved from the command's current working directory. Quote paths containing spaces:

```bash
tau tool pdf-unpack './docs/design review.pdf'
```

The command uploads the PDF to Mistral for OCR and renders page-image patches locally. Do not use it for a sensitive document unless sending it to Mistral and retaining derived local artifacts are both permitted.

## Outputs and recovery

On success, stdout reports the persistent temporary output directory and a complete artifact list. The directory contains:

- `document.md`: the complete OCR document with recognized tables inlined.
- `pages/page-0001.md` and later numbered files: one Markdown file per PDF page.
- `images/page-0001/patch-0001.png` and later numbered patches: images for visual verification.

OCR text can contain recognition mistakes. Embedded visuals that are not represented in Markdown are marked with placeholders pointing to the corresponding page patches. Read `document.md` for the whole document, use `pages/` for page-level work, and inspect `images/` before trusting or correcting uncertain OCR.

The command attempts to delete the remote upload after OCR. A deletion failure is reported in the command output. Successful local artifacts remain on disk for follow-up use; delete them when they are no longer needed. If processing fails, Tau attempts to remove the partial local output directory.

See [command-line tools](tools.md) for command discovery and execution ownership.
