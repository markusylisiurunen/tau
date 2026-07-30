import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type DiscoveryMetadataResponse = {
  url: string;
  status: number;
  contentType: string;
  vary: string;
  location?: string;
};

type DiscoveryRequest = (
  url: URL,
  options: { accept: string; sameOrigin?: string },
) => Promise<DiscoveryMetadataResponse>;

function parseWebUrl(value: string | URL): URL {
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
  if (url.port) {
    throw new Error("web.discover url must use the default http or https port");
  }
  url.hash = "";
  return url;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function assertPublicAddress(address: string, family: 4 | 6): void {
  const type = family === 6 ? "ipv6" : "ipv4";
  const blocked = family === 6 ? blockedIpv6Addresses : blockedIpv4Addresses;
  if (blocked.check(address, type)) {
    throw new Error("web.discover only supports public web addresses");
  }
}

async function resolvePublicAddresses(url: URL): Promise<ResolvedAddress[]> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    addresses = (await lookup(hostname, { all: true, verbatim: true })).map((entry) => {
      if (entry.family !== 4 && entry.family !== 6) {
        throw new Error(`web.discover received unsupported address family '${entry.family}'`);
      }
      return { address: entry.address, family: entry.family };
    });
  }
  if (addresses.length === 0) {
    throw new Error(`web.discover could not resolve '${hostname}'`);
  }
  for (const entry of addresses) {
    assertPublicAddress(entry.address, entry.family);
  }
  return addresses;
}

export async function assertPublicWebUrl(value: string | URL): Promise<URL> {
  const url = parseWebUrl(value);
  await resolvePublicAddresses(url);
  return url;
}

function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === "object" ? options.family : undefined;
    const matching = addresses.filter(
      (entry) => !requestedFamily || entry.family === requestedFamily,
    );
    const selected = matching.length > 0 ? matching : addresses;
    if (typeof options === "object" && options.all) {
      callback(null, selected);
      return;
    }
    const first = selected[0];
    if (!first) {
      callback(new Error("web.discover could not select a resolved address"), "", 4);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function requestOnce(
  url: URL,
  options: { accept: string; addresses: ResolvedAddress[] },
): Promise<DiscoveryMetadataResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? requestHttps : requestHttp;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const request = transport(
      url,
      {
        method: "GET",
        headers: {
          Accept: options.accept,
          "Accept-Encoding": "identity",
          "User-Agent": "tau-web-discovery",
        },
        lookup: createPinnedLookup(options.addresses),
      },
      (response) => {
        const result = {
          url: url.toString(),
          status: response.statusCode ?? 0,
          contentType: (String(response.headers["content-type"] ?? "").split(";", 1)[0] ?? "")
            .trim()
            .toLowerCase(),
          vary: String(response.headers.vary ?? ""),
          ...(response.headers.location ? { location: response.headers.location } : {}),
        };
        response.destroy();
        finish(() => resolve(result));
      },
    );
    request.setTimeout(DISCOVERY_TIMEOUT_MS, () => {
      request.destroy(new Error("web.discover request timed out"));
    });
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

export async function requestPublicMetadata(
  value: string | URL,
  {
    accept,
    redirects = MAX_REDIRECTS,
    sameOrigin,
  }: {
    accept: string;
    redirects?: number;
    sameOrigin?: string;
  },
): Promise<DiscoveryMetadataResponse> {
  const url = parseWebUrl(value);
  const addresses = await resolvePublicAddresses(url);
  const response = await requestOnce(url, { accept, addresses });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
    if (redirects === 0) throw new Error("web.discover followed too many redirects");
    const redirectUrl = new URL(response.location, url);
    if (sameOrigin && redirectUrl.origin !== sameOrigin) {
      throw new Error("web.discover same-origin probe redirected to another origin");
    }
    return requestPublicMetadata(redirectUrl, {
      accept,
      redirects: redirects - 1,
      sameOrigin,
    });
  }
  return response;
}

function isMarkdownContentType(contentType: string): boolean {
  return contentType === "text/markdown" || contentType === "text/x-markdown";
}

function isTextDiscoveryResponse(
  response: DiscoveryMetadataResponse,
  allowPlainText: boolean,
): boolean {
  return (
    response.status === 200 &&
    (isMarkdownContentType(response.contentType) ||
      (allowPlainText && response.contentType === "text/plain"))
  );
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
  const root = new URL("/llms.txt", requestedUrl);
  const firstSegment = requestedUrl.pathname.split("/").filter(Boolean)[0];
  if (!firstSegment) return [root];
  return [root, new URL(`/${firstSegment}/llms.txt`, requestedUrl)];
}

async function optionalRequest(
  request: DiscoveryRequest,
  url: URL,
  options: Parameters<DiscoveryRequest>[1],
): Promise<DiscoveryMetadataResponse | undefined> {
  try {
    return await request(url, options);
  } catch {
    return undefined;
  }
}

export async function discoverAgentContent(
  value: string,
  {
    request = requestPublicMetadata,
    validate = assertPublicWebUrl,
  }: {
    request?: DiscoveryRequest;
    validate?: (value: string) => Promise<URL>;
  } = {},
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
  const requestedUrl = await validate(value);
  const negotiatedRequest = optionalRequest(request, requestedUrl, {
    accept: "text/markdown, text/plain;q=0.9, text/html;q=0.1",
  });
  const markdownCandidates = buildMarkdownCandidates(requestedUrl);
  const markdownRequests = markdownCandidates.map((url) =>
    optionalRequest(request, url, {
      accept: "text/markdown, text/plain;q=0.9",
      sameOrigin: requestedUrl.origin,
    }),
  );
  const llmsTxtCandidates = buildLlmsTxtCandidates(requestedUrl);
  const llmsTxtRequests = llmsTxtCandidates.map((url) =>
    optionalRequest(request, url, {
      accept: "text/plain, text/markdown;q=0.9",
      sameOrigin: requestedUrl.origin,
    }),
  );
  const [negotiated, markdownResponses, llmsTxtResponses] = await Promise.all([
    negotiatedRequest,
    Promise.all(markdownRequests),
    Promise.all(llmsTxtRequests),
  ]);

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
        .some((value) => value.trim().toLowerCase() === "accept"),
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
