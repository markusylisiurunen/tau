# @tau/web

Use `search` to find relevant pages, `fetch` to read known URLs, and `discover` to locate Markdown alternatives. When a local file, repository, or first-party API can answer the question, use that source first.

```js
import { search, fetch } from "@tau/web";

const { results } = await search("Node.js release schedule", {
  numResults: 3,
  includeDomains: ["nodejs.org"],
});
const page = results[0] && await fetch(results[0].url, {
  text: { maxCharacters: 4_000 },
});
```

## Search

`search(query, options?)` returns ranked results with automatically selected highlights. Options include `numResults` (default 10), `includeDomains`, `excludeDomains`, `startPublishedDate`, `endPublishedDate`, `category`, `userLocation`, `objective`, and `maxAgeHours`. Use ISO 8601 dates and a two-letter country code. Leave freshness unset unless the task depends on it; `maxAgeHours: 0` requests live retrieval.

## Fetch

`fetch(urlOrUrls, options?)` extracts content for one URL or an array. By default it returns highlights. Set `text: true` for extracted page text or `text: { maxCharacters }` for an excerpt. Set `highlights: true` or `highlights: { query?, maxCharacters? }` to request highlights explicitly. Both can be requested together. Other options are `maxAgeHours`, `subpages`, `subpageTarget`, and `extras: { links }`, where `links` is the maximum number to return per page.

Both methods return `{ results, statuses, notices }`. Results have `url`, `title`, and any requested content (`text`, `highlights`, `subpages`, `extras.links`) that was available. They can include `id`, `publishedDate`, and `author`. A successful call can include individual failures in `statuses`; inspect each status's `id`, `status`, and optional `error` before relying on batch results. `notices` contains messages about how the request was handled. Request-level failures throw.

## Discovery

`discover(url)` looks for negotiated Markdown, standalone Markdown URLs, and `llms.txt`, without performing search or returning page text. Inspect `negotiated`, `markdown`, and `llmsTxt` in the result. Fetch the selected URL separately. Only absolute HTTP and HTTPS URLs are supported.
