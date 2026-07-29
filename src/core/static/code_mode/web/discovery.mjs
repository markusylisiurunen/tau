import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";

const DISCOVERY_TIMEOUT_MS = 8_000;
const DISCOVERY_BODY_BYTES = 64 * 1024;
const LLMS_TXT_CHARACTERS = 20_000;
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
]) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

function parseWebUrl(value) {
  let url;
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

function normalizedHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function assertPublicAddress(address, family) {
  const type = family === 6 ? "ipv6" : "ipv4";
  const blocked = family === 6 ? blockedIpv6Addresses : blockedIpv4Addresses;
  if (blocked.check(address, type)) {
    throw new Error("web.discover only supports public web addresses");
  }
}

async function resolvePublicAddresses(url) {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`web.discover could not resolve '${hostname}'`);
  }
  for (const entry of addresses) {
    assertPublicAddress(entry.address, entry.family);
  }
  return addresses;
}

export async function assertPublicWebUrl(value) {
  const url = parseWebUrl(value);
  await resolvePublicAddresses(url);
  return url;
}

function createPinnedLookup(addresses) {
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
    callback(null, selected[0].address, selected[0].family);
  };
}

function requestOnce(url, options) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? requestHttps : requestHttp;
    let settled = false;
    const finish = (callback) => {
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
        const chunks = [];
        let bytes = 0;
        let truncated = false;
        response.on("data", (chunk) => {
          if (truncated) return;
          const remaining = options.maxBytes - bytes;
          if (chunk.length > remaining) {
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            bytes = options.maxBytes;
            truncated = true;
            response.destroy();
            finish(() =>
              resolve({
                response,
                body: Buffer.concat(chunks).toString("utf8"),
                truncated,
              }),
            );
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
        });
        response.on("end", () =>
          finish(() =>
            resolve({
              response,
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
            }),
          ),
        );
        response.on("error", (error) => finish(() => reject(error)));
      },
    );
    request.setTimeout(DISCOVERY_TIMEOUT_MS, () => {
      request.destroy(new Error("web.discover request timed out"));
    });
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

export async function requestPublicText(
  value,
  { accept, maxBytes = DISCOVERY_BODY_BYTES, redirects = MAX_REDIRECTS, sameOrigin } = {},
) {
  const url = parseWebUrl(value);
  const addresses = await resolvePublicAddresses(url);
  const { response, body, truncated } = await requestOnce(url, {
    accept,
    maxBytes,
    addresses,
  });
  const status = response.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
    if (redirects === 0) throw new Error("web.discover followed too many redirects");
    const redirectUrl = new URL(response.headers.location, url);
    if (sameOrigin && redirectUrl.origin !== sameOrigin) {
      throw new Error("web.discover same-origin probe redirected to another origin");
    }
    return requestPublicText(redirectUrl, {
      accept,
      maxBytes,
      redirects: redirects - 1,
      sameOrigin,
    });
  }
  return {
    url: url.toString(),
    status,
    contentType: String(response.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase(),
    contentEncoding: String(response.headers["content-encoding"] ?? "").toLowerCase(),
    vary: String(response.headers.vary ?? ""),
    body,
    truncated,
  };
}

function isMarkdownContentType(contentType) {
  return contentType === "text/markdown" || contentType === "text/x-markdown";
}

function isTextDiscoveryResponse(response, allowPlainText) {
  return (
    response.status === 200 &&
    (!response.contentEncoding || response.contentEncoding === "identity") &&
    (isMarkdownContentType(response.contentType) ||
      (allowPlainText && response.contentType === "text/plain"))
  );
}

function buildMarkdownCandidates(requestedUrl) {
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

function buildLlmsTxtCandidates(requestedUrl) {
  const root = new URL("/llms.txt", requestedUrl);
  const firstSegment = requestedUrl.pathname.split("/").filter(Boolean)[0];
  if (!firstSegment) return [root];
  return [root, new URL(`/${firstSegment}/llms.txt`, requestedUrl)];
}

async function optionalRequest(request, url, options) {
  try {
    return await request(url, options);
  } catch {
    return undefined;
  }
}

export async function discoverAgentContent(
  value,
  {
    request = requestPublicText,
    validate = assertPublicWebUrl,
    llmsTxtCharacters = LLMS_TXT_CHARACTERS,
  } = {},
) {
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
      maxBytes: Math.max(llmsTxtCharacters * 4, llmsTxtCharacters),
      sameOrigin: requestedUrl.origin,
    }),
  );
  const [negotiated, markdownResponses, llmsTxtResponses] = await Promise.all([
    negotiatedRequest,
    Promise.all(markdownRequests),
    Promise.all(llmsTxtRequests),
  ]);

  const markdown = [];
  const markdownUrls = new Set();
  if (negotiated && isTextDiscoveryResponse(negotiated, false)) {
    markdownUrls.add(negotiated.url);
    markdown.push({
      url: negotiated.url,
      via: "content-negotiation",
      contentType: negotiated.contentType,
      varyAccept: negotiated.vary
        .split(",")
        .some((value) => value.trim().toLowerCase() === "accept"),
    });
  }
  for (const response of markdownResponses) {
    if (
      !response ||
      markdownUrls.has(response.url) ||
      !isTextDiscoveryResponse(response, true)
    ) {
      continue;
    }
    markdownUrls.add(response.url);
    markdown.push({
      url: response.url,
      via: "markdown-path",
      contentType: response.contentType,
    });
  }

  const llmsTxt = [];
  for (const response of llmsTxtResponses) {
    if (!response || !isTextDiscoveryResponse(response, true)) continue;
    const content = response.body.slice(0, llmsTxtCharacters);
    llmsTxt.push({
      url: response.url,
      content,
      truncated: response.truncated || content.length < response.body.length,
    });
  }

  return {
    requestedUrl: requestedUrl.toString(),
    markdown,
    llmsTxt,
  };
}
