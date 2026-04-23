import { z } from "zod";

const MISTRAL_FILES_URL = "https://api.mistral.ai/v1/files";
const MISTRAL_DOCUMENT_OCR_URL = "https://api.mistral.ai/v1/ocr";
const DEFAULT_MISTRAL_DOCUMENT_OCR_MODEL = "mistral-ocr-latest";
const DEFAULT_MISTRAL_DOCUMENT_MIME_TYPE = "application/pdf";

const errorSchema = z.union([
  z.object({ message: z.string() }),
  z.object({ detail: z.string() }),
  z.object({ error: z.object({ message: z.string() }) }),
]);

const uploadSuccessSchema = z.object({
  id: z.string().uuid(),
});

const tableSchema = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    format: z.string(),
  })
  .passthrough();

const imageSchema = z
  .object({
    id: z.string().min(1),
    top_left_x: z.number().int().nonnegative().nullable().optional(),
    top_left_y: z.number().int().nonnegative().nullable().optional(),
    bottom_right_x: z.number().int().nonnegative().nullable().optional(),
    bottom_right_y: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const successSchema = z.object({
  pages: z
    .array(
      z
        .object({
          index: z.number().int().nonnegative(),
          markdown: z.string(),
          tables: z.array(tableSchema).optional(),
          images: z.array(imageSchema).optional(),
        })
        .passthrough(),
    )
    .min(1),
});

export type MistralDocumentOcrOptions = {
  apiKey: string;
  document: Buffer;
  fileName: string;
  model?: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
};

export type MistralDocumentOcrTable = {
  id: string;
  content: string;
  format: string;
};

export type MistralDocumentOcrImage = {
  id: string;
  topLeftX?: number | null;
  topLeftY?: number | null;
  bottomRightX?: number | null;
  bottomRightY?: number | null;
};

export type MistralDocumentOcrPage = {
  markdown: string;
  tables: MistralDocumentOcrTable[];
  images: MistralDocumentOcrImage[];
};

export type MistralDocumentOcrResult = {
  pages: MistralDocumentOcrPage[];
  cleanupWarning?: string;
};

function parseResponsePayload(responseText: string): unknown {
  try {
    return responseText ? (JSON.parse(responseText) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function parseErrorMessage(responseText: string, payload: unknown, status: number): string {
  const parsed = errorSchema.safeParse(payload);
  if (parsed.success) {
    if ("message" in parsed.data) {
      return parsed.data.message;
    }
    if ("detail" in parsed.data) {
      return parsed.data.detail;
    }
    return parsed.data.error.message;
  }

  return responseText.trim() || `HTTP ${status}`;
}

async function uploadMistralFile(args: {
  apiKey: string;
  document: Buffer;
  fileName: string;
  mimeType: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const formData = new FormData();
  formData.append("purpose", "ocr");
  formData.append(
    "file",
    new Blob([Uint8Array.from(args.document)], {
      type: args.mimeType,
    }),
    args.fileName,
  );

  const response = await args.fetchImpl(MISTRAL_FILES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: formData,
  });

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText);
  if (!response.ok) {
    throw new Error(parseErrorMessage(responseText, payload, response.status));
  }

  const parsed = uploadSuccessSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("unexpected Mistral file upload response format");
  }

  return parsed.data.id;
}

async function deleteMistralFile(args: {
  apiKey: string;
  fileId: string;
  fetchImpl: typeof fetch;
}): Promise<string | undefined> {
  try {
    const response = await args.fetchImpl(`${MISTRAL_FILES_URL}/${args.fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
      },
    });

    if (response.ok) {
      return undefined;
    }

    const responseText = await response.text();
    const payload = parseResponsePayload(responseText);
    return `failed to delete the uploaded PDF from Mistral: ${parseErrorMessage(responseText, payload, response.status)}`;
  } catch (error) {
    return `failed to delete the uploaded PDF from Mistral: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function ocrMistralDocument(
  options: MistralDocumentOcrOptions,
): Promise<MistralDocumentOcrResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const fileId = await uploadMistralFile({
    apiKey: options.apiKey,
    document: options.document,
    fileName: options.fileName,
    mimeType: options.mimeType ?? DEFAULT_MISTRAL_DOCUMENT_MIME_TYPE,
    fetchImpl: fetchFn,
  });

  let pages: MistralDocumentOcrPage[] | undefined;
  let operationError: Error | undefined;

  try {
    const response = await fetchFn(MISTRAL_DOCUMENT_OCR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MISTRAL_DOCUMENT_OCR_MODEL,
        document: {
          type: "file",
          file_id: fileId,
        },
        table_format: "markdown",
      }),
    });

    const responseText = await response.text();
    const payload = parseResponsePayload(responseText);
    if (!response.ok) {
      throw new Error(parseErrorMessage(responseText, payload, response.status));
    }

    const parsed = successSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("unexpected Mistral OCR response format");
    }

    const sortedPages = [...parsed.data.pages].sort((a, b) => a.index - b.index);
    for (const [expectedIndex, page] of sortedPages.entries()) {
      if (page.index !== expectedIndex) {
        throw new Error("unexpected Mistral OCR page indexes");
      }
    }

    pages = sortedPages.map((page) => ({
      markdown: page.markdown,
      tables: (page.tables ?? []).map((table) => ({
        id: table.id,
        content: table.content,
        format: table.format,
      })),
      images: (page.images ?? []).map((image) => ({
        id: image.id,
        topLeftX: image.top_left_x,
        topLeftY: image.top_left_y,
        bottomRightX: image.bottom_right_x,
        bottomRightY: image.bottom_right_y,
      })),
    }));
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupWarning = await deleteMistralFile({
    apiKey: options.apiKey,
    fileId,
    fetchImpl: fetchFn,
  });

  if (operationError) {
    if (cleanupWarning) {
      throw new Error(`${operationError.message} (${cleanupWarning})`);
    }
    throw operationError;
  }

  if (!pages) {
    throw new Error("Mistral OCR completed without pages");
  }

  return {
    pages,
    cleanupWarning,
  };
}
