# PDF unpacking

`tau tool pdf-unpack` turns a PDF into OCR Markdown and page images.

## Credentials and requirements

Needs `MISTRAL_API_KEY` or `apiKeys.mistral`, and `pdftoppm` from Poppler (`brew install poppler` or `apt install poppler-utils`).

## Input and examples

```bash
tau tool pdf-unpack './docs/design review.pdf'
```

The PDF is uploaded to Mistral and deleted afterwards when possible.

## Outputs and recovery

Stdout prints a temporary output directory, which is kept until you delete it:

- `document.md`: the whole document
- `pages/page-0001.md`: one file per page
- `images/page-0001/patch-0001.png`: page images for checking uncertain OCR

OCR can contain mistakes, and figures appear as placeholders pointing to page images. Running the command again after a failed OCR request may be charged again.
