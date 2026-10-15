import {
  type MarkdownExportConfig,
  markdownExportConfigSchema,
  parseMarkdownExportUrl,
} from "../core/config/markdown_export.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export async function exportMarkdown(options: {
  config: MarkdownExportConfig;
  markdown: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<string> {
  const parsed = markdownExportConfigSchema.safeParse(options.config);
  if (!parsed.success) throw new Error("Invalid Markdown export configuration.");
  const config = parsed.data;
  const token =
    config.token ?? (config.tokenEnv ? options.env[config.tokenEnv]?.trim() : undefined);
  if ((config.tokenEnv && token === undefined) || token === "") {
    throw new Error("The Markdown export token environment variable is missing or empty.");
  }
  if (token !== undefined && !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("Invalid Markdown export token.");
  }

  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ version: 1, markdown: options.markdown }),
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(
      "Markdown export request failed or was cancelled. The service may have received it; Tau did not retry.",
    );
  }
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `Markdown export returned HTTP ${response.status}; expected 201. Tau did not retry.`,
    );
  }

  let result: unknown;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Markdown export returned an empty response.");
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Response too large.");
      chunks.push(value);
    }
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(
      "Markdown export returned an invalid or incomplete response. Tau did not retry.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("version" in result) ||
    result.version !== 1 ||
    !("url" in result) ||
    typeof result.url !== "string" ||
    !parseMarkdownExportUrl(result.url)
  ) {
    throw new Error("Markdown export requires a version 1 response with an HTTP(S) URL.");
  }
  return result.url;
}
