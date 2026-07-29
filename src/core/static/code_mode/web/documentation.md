# Tau web API

The one-shot JavaScript runtime provides these globals:

- `web.discover(url)`: discover metadata for direct Markdown representations and `llms.txt` files for a documentation URL.
- `web.search(query, options?)`: search the web and return relevant page highlights.
- `web.fetch(urls, options?)`: retrieve highlights or bounded text from known URLs through the web extraction service.
- `docs`: this document.
- `console`: program output. Only text written through console methods is returned; return values are ignored.

Top-level `await` is supported. Do not import or construct an API client. Calls may run concurrently with `Promise.all`.

## Defaults

The API is designed for agent workflows and defaults to token-efficient retrieval:

- Search uses automatic search with 10 results unless `numResults` is set.
- Search always requests highlights rather than full page text.
- Fetch defaults to highlights. Use `mode: "text"` only when fuller page content is needed.
- Cached content is accepted with live retrieval as fallback. Set `maxAgeHours` only when the task has a specific freshness requirement.
- Responses contain only fields relevant to generated programs. Provider metadata, billing fields, images, and ranking internals are omitted.
- Streaming is not supported. Each method resolves to one response object.

## `web.discover(url)`

Use discovery as a separate first step when the user provides a documentation URL and a direct agent-friendly representation may exist. Print a concise discovery report, then decide in the next turn whether to use `curl`, `web.fetch`, or another approach.

```js
const discovery = await web.discover("https://example.com/docs/getting-started");

console.log(`Requested: ${discovery.requestedUrl}`);
for (const representation of discovery.markdown) {
  console.log(
    `Markdown: ${representation.url} (${representation.via}, ${representation.contentType})`,
  );
}
for (const file of discovery.llmsTxt) {
  console.log(`llms.txt: ${file.url} (${file.contentType})`);
}
```

Discovery checks:

1. The original URL with Markdown content negotiation.
2. Deterministic same-origin `.md` and `/index.md` paths.
3. `/llms.txt` and `/<first-path-segment>/llms.txt`.

Discovery returns metadata only. It does not return page or `llms.txt` bodies, parse Markdown links, match entries to the requested page, or automatically follow anything listed there. Missing discovery files are omitted.

### Response

```js
{
  requestedUrl: string,
  markdown: [
    {
      url: string,
      via: "content-negotiation" | "markdown-path",
      contentType: "text/markdown" | "text/x-markdown" | "text/plain",
      varyAccept?: boolean,
    },
  ],
  llmsTxt: [
    {
      url: string,
      contentType: "text/markdown" | "text/x-markdown" | "text/plain",
    },
  ],
}
```

Retrieve an explicit Markdown or `llms.txt` URL with `curl` in a later Bash call:

```bash
curl -fsSL -H 'Accept: text/markdown' \
  'https://example.com/docs/getting-started/index.md'
```

For content negotiation, request the original URL with the same header. Use `web.fetch` instead when extraction through the web search infrastructure is preferable.

## `web.search(query, options?)`

Search the web and retrieve highlights in one request.

```js
const response = await web.search("latest Tau releases", {
  numResults: 5,
  includeDomains: ["github.com"],
});
```

### Options

| Option | Type | Behavior |
| --- | --- | --- |
| `numResults` | integer, 1-100 | Number of results. Defaults to 10. |
| `includeDomains` | non-empty string array | Return only matching domains or path prefixes. |
| `excludeDomains` | non-empty string array | Exclude matching domains or path prefixes. |
| `startPublishedDate` | string | Return pages published after this ISO 8601 date. |
| `endPublishedDate` | string | Return pages published before this ISO 8601 date. |
| `category` | string | One of `company`, `people`, `publication`, `news`, `personal site`, or `financial report`. |
| `userLocation` | two-letter country code | Bias results toward a country. |
| `maxAgeHours` | integer >= -1 | Maximum cached-content age. `0` always retrieves live; `-1` uses cache only. Omit for the recommended default. |

Do not combine `excludeDomains` or publication-date filters with the `company` or `people` categories; those combinations are unsupported.

### Response

```js
{
  results: [
    {
      title: string,
      url: string,
      publishedDate?: string,
      author?: string,
      highlights?: string[],
    },
  ],
  statuses: [
    {
      id: string,
      status: "success" | "error",
      error?: { tag?: string, httpStatusCode?: number },
    },
  ],
}
```

Results are relevance ordered. Check `statuses` when inline content is important because an individual page may fail retrieval while the overall search succeeds.

## `web.fetch(urls, options?)`

Retrieve content from one URL or a non-empty URL array.

```js
const response = await web.fetch("https://example.com/article", {
  query: "release date and breaking changes",
});
```

### Options

| Option | Type | Behavior |
| --- | --- | --- |
| `mode` | `"highlights"` or `"text"` | Content mode. Defaults to `"highlights"`. |
| `query` | string | Guides highlight selection. Available only in highlights mode. |
| `maxCharacters` | positive integer | Caps highlight or text characters per URL. Omit for the service default. |
| `maxAgeHours` | integer >= -1 | Maximum cached-content age. `0` always retrieves live; `-1` uses cache only. |
| `subpages` | non-negative integer | Number of linked subpages to retrieve per URL. |
| `subpageTarget` | string or non-empty string array | Guides linked-subpage selection. |
| `links` | non-negative integer | Number of links to return from each page. |

Use highlights for focused questions and multi-step research. Use bounded text when exact context or comprehensive reading is necessary:

```js
const response = await web.fetch(urls, {
  mode: "text",
  maxCharacters: 12_000,
});
```

### Response

Fetch returns the same top-level `{ results, statuses }` shape as search. Result objects may contain:

```js
{
  title: string,
  url: string,
  publishedDate?: string,
  author?: string,
  highlights?: string[],
  text?: string,
  subpages?: Array<{ /* same result fields */ }>,
  links?: string[],
}
```

Always inspect `statuses` for fetch calls. A fetch request can succeed overall while individual URLs report errors such as not found, forbidden, or live-retrieval timeout.

## Common patterns

### Format evidence compactly

```js
const { results } = await web.search("current browser compatibility for CSS nesting", {
  numResults: 5,
});

for (const result of results) {
  console.log(`${result.title}\n${result.url}`);
  for (const highlight of result.highlights ?? []) console.log(`- ${highlight}`);
}
```

### Search several query variants concurrently

```js
const queries = [
  "Tau latest release notes",
  "Tau recent breaking changes",
  "Tau GitHub releases",
];
const responses = await Promise.all(
  queries.map((query) => web.search(query, { numResults: 5 })),
);

const unique = new Map();
for (const response of responses) {
  for (const result of response.results) unique.set(result.url, result);
}
for (const result of unique.values()) {
  console.log(`${result.title}\n${result.url}`);
}
```

### Search first, then fetch selected pages

```js
const { results } = await web.search("official Tau documentation", {
  numResults: 8,
  includeDomains: ["github.com"],
});
const urls = results.slice(0, 3).map((result) => result.url);
const pages = await web.fetch(urls, {
  query: "installation and configuration instructions",
});

for (const page of pages.results) {
  console.log(`${page.title}\n${page.url}`);
  for (const highlight of page.highlights ?? []) console.log(`- ${highlight}`);
}
```

## Output guidance

Print only information needed for the task. Prefer concise labeled text over serialized response objects. Select relevant fields when possible; when all fields matter, flatten and label them compactly. Emit JSON only when the user explicitly requests JSON or another machine-readable result.
