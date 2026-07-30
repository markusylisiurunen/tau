import { z } from "zod";
import type { ToolExecutionBackend } from "./execution_backend.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_REQUEST_TIMEOUT_MS = 8_000;
const DISCOVERY_MAX_CAPTURE_BYTES = 256 * 1024;

const discoveryRequestSchema = z.object({
  url: z.string(),
  accept: z.string(),
  sameOrigin: z.string().optional(),
});
const discoveryResponseSchema = z
  .object({
    url: z.string(),
    status: z.number().int(),
    contentType: z.string(),
    vary: z.string(),
  })
  .nullable();
const discoveryResponsesSchema = z.array(discoveryResponseSchema);

type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
type DiscoveryResponse = Exclude<z.infer<typeof discoveryResponseSchema>, null>;

const DISCOVERY_SCRIPT = `
const requests = JSON.parse(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
const responses = await Promise.all(
  requests.map(async (request) => {
    try {
      const response = await fetch(request.url, {
        headers: {
          Accept: request.accept,
          "User-Agent": "tau-web-discovery",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => {});
      if (request.sameOrigin && new URL(response.url).origin !== request.sameOrigin) {
        return null;
      }
      return {
        url: response.url,
        status: response.status,
        contentType: (response.headers.get("content-type") || "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase(),
        vary: response.headers.get("vary") || "",
      };
    } catch {
      return null;
    }
  }),
);
process.stdout.write(JSON.stringify(responses));
`.trim();

function parseWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("web.discover url must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web.discover url must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("web.discover url must not contain credentials");
  }
  url.hash = "";
  return url;
}

function buildMarkdownCandidates(requestedUrl: URL): URL[] {
  const candidate = new URL(requestedUrl);
  candidate.search = "";
  const path = candidate.pathname;
  if (path.endsWith(".md")) return [candidate];
  const paths = path.endsWith("/") ? [`${path}index.md`] : [`${path}.md`, `${path}/index.md`];
  return paths.map((pathname) => {
    const url = new URL(candidate);
    url.pathname = pathname.replace(/\/+/g, "/");
    return url;
  });
}

function buildLlmsTxtCandidates(requestedUrl: URL): URL[] {
  const candidates = [new URL("/llms.txt", requestedUrl)];
  let pathPrefix = "";
  for (const segment of requestedUrl.pathname.split("/").filter(Boolean)) {
    pathPrefix += `/${segment}`;
    candidates.push(new URL(`${pathPrefix}/llms.txt`, requestedUrl));
  }
  return candidates;
}

function buildDiscoveryRequests(requestedUrl: URL): {
  negotiated: DiscoveryRequest;
  markdown: DiscoveryRequest[];
  llmsTxt: DiscoveryRequest[];
} {
  return {
    negotiated: {
      url: requestedUrl.toString(),
      accept: "text/markdown, text/plain;q=0.9, text/html;q=0.1",
    },
    markdown: buildMarkdownCandidates(requestedUrl).map((url) => ({
      url: url.toString(),
      accept: "text/markdown, text/plain;q=0.9",
      sameOrigin: requestedUrl.origin,
    })),
    llmsTxt: buildLlmsTxtCandidates(requestedUrl).map((url) => ({
      url: url.toString(),
      accept: "text/plain, text/markdown;q=0.9",
      sameOrigin: requestedUrl.origin,
    })),
  };
}

async function executeDiscoveryRequests(
  backend: ToolExecutionBackend,
  requests: DiscoveryRequest[],
  signal: AbortSignal,
): Promise<Array<DiscoveryResponse | null>> {
  const result = await backend.runNodeScript(
    DISCOVERY_SCRIPT,
    [JSON.stringify(requests), String(DISCOVERY_REQUEST_TIMEOUT_MS)],
    {
      signal,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maxCaptureBytes: DISCOVERY_MAX_CAPTURE_BYTES,
    },
  );
  if (result.aborted) throw new Error("web.discover aborted");
  if (result.timedOut) throw new Error("web.discover timed out");
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.output.trim() || "web.discover request failed");
  }
  if (result.truncated) {
    throw new Error("web.discover response exceeded the capture limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("web.discover returned invalid JSON");
  }
  const responses = discoveryResponsesSchema.safeParse(parsed);
  if (!responses.success || responses.data.length !== requests.length) {
    throw new Error("web.discover returned an invalid response");
  }
  return responses.data;
}

function isMarkdownContentType(contentType: string): boolean {
  return contentType === "text/markdown" || contentType === "text/x-markdown";
}

function isTextDiscoveryResponse(response: DiscoveryResponse, allowPlainText: boolean): boolean {
  return (
    response.status === 200 &&
    (isMarkdownContentType(response.contentType) ||
      (allowPlainText && response.contentType === "text/plain"))
  );
}

export async function discoverAgentContent(
  backend: ToolExecutionBackend,
  value: string,
  signal: AbortSignal,
): Promise<{
  requestedUrl: string;
  markdown: Array<{
    url: string;
    via: "content-negotiation" | "markdown-path";
    contentType: string;
    varyAccept?: boolean;
  }>;
  llmsTxt: Array<{ url: string; contentType: string }>;
}> {
  const requestedUrl = parseWebUrl(value);
  const requests = buildDiscoveryRequests(requestedUrl);
  const flatRequests = [requests.negotiated, ...requests.markdown, ...requests.llmsTxt];
  const responses = await executeDiscoveryRequests(backend, flatRequests, signal);
  const negotiated = responses[0];
  const markdownResponses = responses.slice(1, requests.markdown.length + 1);
  const llmsTxtResponses = responses.slice(requests.markdown.length + 1);

  const markdown = [];
  const markdownUrls = new Set<string>();
  if (negotiated && isTextDiscoveryResponse(negotiated, false)) {
    markdownUrls.add(negotiated.url);
    markdown.push({
      url: negotiated.url,
      via: "content-negotiation" as const,
      contentType: negotiated.contentType,
      varyAccept: negotiated.vary
        .split(",")
        .some((entry) => entry.trim().toLowerCase() === "accept"),
    });
  }
  for (const response of markdownResponses) {
    if (!response || markdownUrls.has(response.url) || !isTextDiscoveryResponse(response, true)) {
      continue;
    }
    markdownUrls.add(response.url);
    markdown.push({
      url: response.url,
      via: "markdown-path" as const,
      contentType: response.contentType,
    });
  }

  const llmsTxt = [];
  for (const response of llmsTxtResponses) {
    if (!response || !isTextDiscoveryResponse(response, true)) continue;
    llmsTxt.push({
      url: response.url,
      contentType: response.contentType,
    });
  }

  return {
    requestedUrl: requestedUrl.toString(),
    markdown,
    llmsTxt,
  };
}
