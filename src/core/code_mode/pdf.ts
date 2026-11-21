import { z } from "zod";
import type { ApiKeysConfig } from "../config/schema.js";
import { unpackPdf } from "../media/pdf.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { definePackage, method } from "./package.js";

export function createPdfPackage(backend: ToolExecutionBackend, config: ApiKeysConfig) {
  return definePackage("pdf", "OCR a PDF into Markdown and page images.", {
    unpack: method(
      z.tuple([
        z.string().min(1),
        z.strictObject({ outputDir: z.string().min(1).optional() }).optional(),
      ]),
      ([path, opts], { signal }) => unpackPdf(path, opts?.outputDir, { backend, config, signal }),
    ),
  });
}
