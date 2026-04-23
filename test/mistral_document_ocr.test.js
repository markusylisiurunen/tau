import { describe, expect, it, vi } from "vitest";
import { ocrMistralDocument } from "../dist/core/utils/mistral_document_ocr.js";

function createJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("mistral document ocr", () => {
  it("uploads the PDF, calls OCR with a file chunk, and deletes the uploaded file", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ id: "c5a188d5-a7fd-43c3-bd89-cba520fa512f" }))
      .mockResolvedValueOnce(
        createJsonResponse({
          pages: [
            {
              index: 1,
              markdown: "page 2 [tbl-1.md](tbl-1.md)",
              tables: [
                {
                  id: "tbl-1.md",
                  content: "| page 2 table |",
                  format: "markdown",
                },
              ],
              images: [],
            },
            {
              index: 0,
              markdown: "page 1 [tbl-0.md](tbl-0.md)",
              tables: [
                {
                  id: "tbl-0.md",
                  content: "| page 1 table |",
                  format: "markdown",
                },
              ],
              images: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ deleted: true }));

    const result = await ocrMistralDocument({
      apiKey: "mistral-key",
      document: Buffer.from("%PDF-1.4\n"),
      fileName: "demo.pdf",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      pages: [
        {
          markdown: "page 1 [tbl-0.md](tbl-0.md)",
          tables: [{ id: "tbl-0.md", content: "| page 1 table |", format: "markdown" }],
          images: [],
        },
        {
          markdown: "page 2 [tbl-1.md](tbl-1.md)",
          tables: [{ id: "tbl-1.md", content: "| page 2 table |", format: "markdown" }],
          images: [],
        },
      ],
      cleanupWarning: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe("https://api.mistral.ai/v1/files");
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.headers.Authorization).toBe("Bearer mistral-key");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(uploadInit.body.get("purpose")).toBe("ocr");

    const uploadedFile = uploadInit.body.get("file");
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile.name).toBe("demo.pdf");
    expect(uploadedFile.type).toBe("application/pdf");

    const [ocrUrl, ocrInit] = fetchMock.mock.calls[1];
    expect(ocrUrl).toBe("https://api.mistral.ai/v1/ocr");
    expect(JSON.parse(ocrInit.body)).toEqual({
      model: "mistral-ocr-latest",
      document: {
        type: "file",
        file_id: "c5a188d5-a7fd-43c3-bd89-cba520fa512f",
      },
      table_format: "markdown",
    });

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[2];
    expect(deleteUrl).toBe("https://api.mistral.ai/v1/files/c5a188d5-a7fd-43c3-bd89-cba520fa512f");
    expect(deleteInit.method).toBe("DELETE");
    expect(deleteInit.headers.Authorization).toBe("Bearer mistral-key");
  });

  it("returns a cleanup warning when uploaded file deletion fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ id: "c5a188d5-a7fd-43c3-bd89-cba520fa512f" }))
      .mockResolvedValueOnce(
        createJsonResponse({
          pages: [
            {
              index: 0,
              markdown: "page 1",
              tables: [],
              images: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ detail: "Unauthorized" }, 401));

    const result = await ocrMistralDocument({
      apiKey: "mistral-key",
      document: Buffer.from("%PDF-1.4\n"),
      fileName: "demo.pdf",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      pages: [{ markdown: "page 1", tables: [], images: [] }],
      cleanupWarning: "failed to delete the uploaded PDF from Mistral: Unauthorized",
    });
  });
});
