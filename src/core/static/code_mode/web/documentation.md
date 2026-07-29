# Tau Exa web runtime

This one-shot JavaScript runtime provides these globals:

- `exa.search(query, options?)`: the installed `exa-js` 2.16.3 search method. Pass the API guide's `query` separately as the first argument and the remaining search request fields as `options`.
- `exa.getContents(urls, options?)`: the installed `exa-js` 2.16.3 contents method. Pass the API guide's `urls` separately as the first argument and the remaining contents request fields as `options`.
- `docs`: this complete Markdown document.
- `console`: standard JavaScript console output. Only stdout and stderr become the tool result; returned values are ignored.

Top-level `await` is supported. The generated program must not import or construct the SDK client; use the provided `exa` global. The complete official documentation for the two supported methods follows.

---

# Official Exa Search API guide

Source: https://exa.ai/docs/reference/search-api-guide-for-coding-agents.md

> ## Documentation Index
>
> Fetch the complete documentation index at: https://exa.ai/docs/llms.txt Use this file to discover all available pages before exploring further.

# Search API Reference

> Self-contained reference with best practices and examples for coding agents

## Overview

**Endpoint:** `POST https://api.exa.ai/search`

**Auth:** Pass your API key via the `Authorization: Bearer` header. Get one at [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys)

## Installation

```bash theme={null}
pip install exa-py    # Python
npm install exa-js    # JavaScript
```

## Minimal Working Example

```bash theme={null}
curl -X POST "https://api.exa.ai/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EXA_API_KEY" \
  -d '{"query": "latest developments in LLMs", "contents": {"highlights": true}}'
```

```python theme={null}
from exa_py import Exa
exa = Exa()
result = exa.search("latest developments in LLMs", contents={"highlights": True})
```

```javascript theme={null}
import Exa from "exa-js";
const exa = new Exa();
const result = await exa.search("latest developments in LLMs", {
  contents: { highlights: true },
});
```

## Request Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | string | **(required)** | Natural language search query. Supports long, semantically rich descriptions. |
| `type` | string | `"auto"` | Search method: `auto`, `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning`. |
| `stream` | boolean | `false` | If `true`, returns `text/event-stream` with OpenAI-compatible chat completion chunks instead of a JSON body. |
| `numResults` | integer | `10` | Number of results (1-100). |
| `category` | string | — | Focus on specific content: `company`, `people`, `publication`, `news`, `personal site`, `financial report`. |
| `userLocation` | string | — | Two-letter ISO country code (e.g. `"US"`). |
| `includeDomains` | string\[] | — | Only return results from these domains. Max 1200. |
| `excludeDomains` | string\[] | — | Exclude results from these domains. Max 1200. |
| `startPublishedDate` | string | — | ISO 8601 date. Only return links published after this date. |
| `endPublishedDate` | string | — | ISO 8601 date. Only return links published before this date. |
| `moderation` | boolean | `false` | Filter unsafe content from results. |
| `additionalQueries` | string\[] | — | Extra query variations for deep-search variants. Used alongside the main query. |
| `systemPrompt` | string | — | Instructions guiding synthesized output and, for deep-search variants, search planning. |
| `outputSchema` | object | — | JSON schema for synthesized `output.content`. When provided, the response includes `output`. See Output Schema section. |
| `compliance` | string | — | Enterprise-only compliance mode. Set to `"hipaa"` for HIPAA mode. HIPAA search requests fail closed if the resolved search path requires live retrieval, keyword/SERP-backed retrieval, summaries, or any other non-HIPAA-safe processor path. |

### Contents Parameters (nested under `contents`)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `contents.text` | boolean or object | — | Return full page text as markdown. Object form: `{maxCharacters, includeHtmlTags, verbosity, includeSections, excludeSections}`. |
| `contents.highlights` | boolean or object | — | Return key excerpts relevant to query. Pass `true` for the highest-quality default. Object form: `{query, maxCharacters}` — use `query` to guide which highlights are returned, `maxCharacters` to cap the budget. |
| `contents.summary` | boolean or object | — | Return LLM-generated summary. Object form: `{query, schema}`. |
| `contents.livecrawlTimeout` | integer | `10000` | Timeout for livecrawling in milliseconds. |
| `contents.maxAgeHours` | integer | — | Max age of cached content in hours. `0` = always livecrawl. `-1` = never livecrawl. Omit for default (livecrawl as fallback). |
| `contents.subpages` | integer | `0` | Number of subpages to crawl per result. |
| `contents.subpageTarget` | string or string\[] | — | Keywords to prioritize when selecting subpages. |
| `contents.extras.links` | integer | `0` | Number of URLs to extract from each page. |
| `contents.extras.imageLinks` | integer | `0` | Number of image URLs to extract from each page. |

### Text Object Options

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `maxCharacters` | integer | — | Character limit for returned text. |
| `includeHtmlTags` | boolean | `false` | Preserve HTML tags in output. |
| `verbosity` | string | `"compact"` | `compact`, `standard`, or `full`. Should use `maxAgeHours: 0` for fresh content. |
| `includeSections` | string\[] | — | Only include these page sections: `header`, `navigation`, `banner`, `body`, `sidebar`, `footer`, `metadata`. Should use `maxAgeHours: 0` for fresh content. |
| `excludeSections` | string\[] | — | Exclude these page sections. Same options as `includeSections`. Should use `maxAgeHours: 0` for fresh content. |

### Highlights Object Options

Prefer `highlights: true` for the highest-quality default. Only supply this object when you specifically need to guide selection with a custom query or cap output size.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | string | — | Custom query that guides which highlights are returned. |
| `maxCharacters` | integer | — | Cap on total highlight characters per URL. Omit unless you have a specific budget — leaving it unset gives the highest-quality default. |

### Summary Object Options

| Parameter | Type   | Default | Description                                |
| --------- | ------ | ------- | ------------------------------------------ |
| `query`   | string | —       | Custom query for the summary.              |
| `schema`  | object | —       | JSON Schema for structured summary output. |

## Token Efficiency

Choosing the right content mode can significantly reduce token usage while maintaining answer quality.

| Mode | Best For |
| --- | --- |
| `text` | Deep analysis, when you need full context, broad research |
| `highlights` | Factual questions, specific lookups, multi-step agent workflows |
| `summary` | Quick overviews, structured extraction, when you want tighter output size control |

**Use `highlights` for agent workflows.** When building multi-step agents that make repeated search calls, `highlights` provide the most relevant excerpts without flooding context windows. For real-time information, set `contents.maxAgeHours: 0` to force livecrawl, knowing that this may increase latency.

```json theme={null}
{
  "query": "What is the current Fed interest rate?",
  "contents": {
    "highlights": true,
    "maxAgeHours": 0
  }
}
```

**Use full `text` for deep research.** When the task requires deeper understanding or when you're unsure which parts of the page matter, request full text and cap it with `maxCharacters`.

```json theme={null}
{
  "query": "detailed analysis of transformer architecture innovations",
  "numResults": 5,
  "contents": {
    "text": {
      "maxCharacters": 15000
    }
  }
}
```

**Combine modes strategically.** You can request both `highlights` and `text` together. Use `highlights` for quick answers and fall back to full text only when needed.

## Search Types

- **`auto`** (default): Balance of speed and quality
- **`fast`**: Low latency. Optimized search models. Good balance of speed and quality.
- **`instant`**: Lowest latency. Optimized for real-time apps (e.g., chat, voice)
- **`deep-lite`**: Lightweight synthesized output with lower latency than the deeper research modes
- **`deep`**: Multi-step search with reasoning and structured outputs
- **`deep-reasoning`**: Deep search with maximum reasoning capability for every step

<Note>
  If you encounter older docs or responses that mention `neural`, treat that as legacy terminology rather than the recommended setting for new code. Start with `auto` unless you have a specific latency or synthesis requirement.
</Note>

## Latency Characteristics

Approximate latency by `type` (hardcoded ballparks — same values surfaced in the dashboard latency slider). Synthesis (`outputSchema`) and forced livecrawls (`contents.maxAgeHours: 0`) stack on top of the base `type`.

| `type` | Approx latency | Notes |
| --- | --- | --- |
| `instant` | \~250 ms | Real-time apps (chat, voice, autocomplete). |
| `fast` | \~450 ms | Optimized search models with good relevance. |
| `auto` (default) | \~1 second | Balanced mode that optimizes for both quality and speed. Recommended for most applications. |
| `deep-lite` | 4 seconds | Lightweight synthesis; cheaper than full `deep`. |
| `deep` | 4-15 seconds | Multi-step planning with structured outputs. |
| `deep-reasoning` | 12-40 seconds | Deep search with maximum reasoning capability per step. |

Modifiers that stack on top of the base `type`:

| Modifier | Effect on latency |
| --- | --- |
| `outputSchema` present | Adds synthesis latency on top of the base `type`. Applies to **every** search type — not just `deep` variants. |
| `contents.maxAgeHours: 720` | Returns cached version if page was crawled before this many hours. Cached contents are much faster than live crawling |

If you're optimizing a real-time path, start with `type: "fast"` or `"instant"`, omit `outputSchema`, omit `maxAgeHours`, and add them back only when the use case requires synthesis, structure, or fresh content.

## Category Filters

| Category | Best For | Restrictions |
| --- | --- | --- |
| `company` | Company pages, LinkedIn company profiles | Does NOT support: `startPublishedDate`, `endPublishedDate`, `excludeDomains`. |
| `people` | Multi-source people data, LinkedIn profiles | Does NOT support: `startPublishedDate`, `endPublishedDate`, `excludeDomains`. |
| `publication` | Scholarly publications — research papers, preprints, journal articles — with structured metadata (authors, venue, citations) | — |
| `news` | Current events, journalism | — |
| `personal site` | Blogs, personal pages | — |
| `financial report` | SEC filings, earnings reports | — |

## Output Schema

For any search type, use `outputSchema` to control the shape of `output.content`:

- `{"type": "text", "description": "..."}` — returns plain text output
- `{"type": "object", "properties": {...}, "required": [...]}` — returns structured JSON

Limits: max nesting depth 2, max total properties 10.

Do NOT include citation fields in your schema — `/search` returns grounding data automatically in `output.grounding`.

## Response Schema

```json theme={null}
{
  "requestId": "b5947044c4b78efa9552a7c89b306d95",
  "searchType": "auto",
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com/page",
      "id": "https://example.com/page",
      "publishedDate": "2024-01-15T00:00:00.000Z",
      "author": "Author Name",
      "image": "https://example.com/image.png",
      "favicon": "https://example.com/favicon.ico",
      "text": "Full page content as markdown...",
      "highlights": ["Key excerpt from the page..."],
      "highlightScores": [0.46],
      "summary": "LLM-generated summary...",
      "subpages": [],
      "extras": {
        "links": ["https://example.com/related"]
      }
    }
  ],
  "output": {
    "content": "Synthesized answer or structured object (deep search only)",
    "grounding": [
      {
        "field": "content",
        "citations": [
          { "url": "https://example.com", "title": "Source Title" }
        ],
        "confidence": "high"
      }
    ]
  },
  "costDollars": {
    "total": 0.007
  }
}
```

### Response Fields

| Field | Type | Description |
| --- | --- | --- |
| `requestId` | string | Unique request identifier. |
| `searchType` | string | Which search type was used (for `auto` queries). |
| `results` | array | List of result objects. |
| `results[].title` | string | Page title. |
| `results[].url` | string | Page URL. |
| `results[].id` | string | Document ID (same as URL). Use with `/contents` endpoint. |
| `results[].publishedDate` | string or null | Estimated publication date (YYYY-MM-DD format). |
| `results[].author` | string or null | Author if available. |
| `results[].image` | string | Associated image URL if available. |
| `results[].favicon` | string | Favicon URL for the domain. |
| `results[].text` | string | Full page text (if `contents.text` requested). |
| `results[].highlights` | string\[] | Key excerpts (if `contents.highlights` requested). |
| `results[].highlightScores` | float\[] | Cosine similarity scores for each highlight. |
| `results[].summary` | string | LLM summary (if `contents.summary` requested). |
| `results[].subpages` | array | Nested results from subpage crawling. |
| `results[].extras.links` | string\[] | Extracted links from the page. |
| `output` | object | Synthesized output object (returned when `outputSchema` is provided). |
| `output.content` | string or object | Synthesized answer. String by default, object when `outputSchema` is provided. |
| `output.grounding` | array | Field-level citations and confidence labels. |
| `output.grounding[].field` | string | Field path (e.g. `"content"`, `"companies[0].funding"`). |
| `output.grounding[].citations` | array | Sources: `{url, title}`. |
| `output.grounding[].confidence` | string | `"low"`, `"medium"`, or `"high"`. |
| `costDollars.total` | float | Total dollar cost for the request. |

### Streaming Response

When `stream: true`, `/search` returns `text/event-stream` instead of a JSON body. Each `data:` frame contains an OpenAI-compatible `chat.completion.chunk` payload. Read partial text from `choices[0].delta.content`.

Example chunk shape:

```json theme={null}
{
  "object": "chat.completion.chunk",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": null
    }
  ]
}
```

## Error Handling

| HTTP Status | Meaning |
| --- | --- |
| 400 | Bad request — invalid parameters, unsupported filter for category. |
| 401 | Invalid or missing API key. |
| 422 | Validation error — check parameter types and constraints. |
| 429 | Rate limit exceeded. |
| 500 | Internal server error. |

Error response shape:

```json theme={null}
{
  "error": "Error message describing the issue"
}
```

## Common Mistakes

<Warning>
  LLMs frequently generate these incorrect parameters. Do NOT use any of the following:

| Wrong | Correct |
| --- | --- |
| `useAutoprompt: true` | Remove it. `useAutoprompt` is **deprecated** and does nothing. |
| `includeUrls` / `excludeUrls` | Use `includeDomains` / `excludeDomains` instead. These parameters accept domains, path prefixes such as `exa.ai/blog`, and subdomain wildcards such as `*.substack.com`. Do not duplicate the filter with a `site:` operator in `query`. |
| `text: true` (top-level) | Nest under `contents`: `"contents": {"text": true}`. The `/search` endpoint requires content params inside `contents`. |
| `summary: true` (top-level) | Nest under `contents`: `"contents": {"summary": true}`. Same nesting rule as `text`. |
| `highlights: {...}` (top-level) | Nest under `contents`: `"contents": {"highlights": {...}}`. |
| `numSentences` | Remove it. This highlights parameter is **deprecated**. Use `highlights: true` instead. |
| `highlightsPerUrl` | Remove it. This highlights parameter is **deprecated**. Use `highlights: true` instead. |
| `tokensNum` | Remove it. This parameter does **not exist**. Use `contents.text.maxCharacters` to limit text length. |
| `livecrawl: "always"` | Use `contents.maxAgeHours: 0` instead. The `livecrawl` parameter is **deprecated**. |
| `excludeDomains` with `category: "company"` or `"people"` | Remove `excludeDomains`. These categories do **not** support `excludeDomains`, `startPublishedDate`, or `endPublishedDate`. |

**Remember:** On the `/search` endpoint, `text`, `highlights`, and `summary` must all be nested inside the `contents` object. This is different from the `/contents` endpoint where they are top-level. </Warning>

## Patterns and Gotchas

- **Use `highlights` over `text` for agent workflows.** Highlights return 10x fewer tokens with the most relevant excerpts. Pass `highlights: true` for the highest-quality default.
- **`auto` is almost always the right `type`.** Only use `fast`/`instant` when latency matters more than quality, or a deep variant for complex multi-step queries.
- **`maxAgeHours: 0` forces livecrawl on every result.** This increases latency. Omit `maxAgeHours` for the default (livecrawl only when no cache exists).
- **`category: "company"` and `category: "people"` disable many filters.** Date filters, text filters, and `excludeDomains` are not supported. Using them returns a 400 error.
- **`outputSchema` works with every search type.** When you need more reasoning depth or more reliable synthesis, prefer `deep-lite`, `deep`, or `deep-reasoning`.
- **`systemPrompt` controls behavior, `outputSchema` controls shape.** Use `systemPrompt` for instructions like "prefer official sources"; use `outputSchema` for the JSON structure you want.
- **`stream: true` switches `/search` to SSE mode.** Expect OpenAI-compatible chat completion chunks, not a single JSON response body.
- **Python SDK uses snake\_case — including dictionary keys.** `numResults` → `num_results`, `maxAgeHours` → `max_age_hours`, `outputSchema` → `output_schema`, etc. This applies inside `contents` dicts too: `contents={"text": {"max_characters": 4000}}`, NOT `{"text": {"maxCharacters": 4000}}`. JavaScript SDK and raw JSON (cURL) use camelCase: `contents: { text: { maxCharacters: 4000 } }`.
- **Combine content modes.** You can request `text`, `highlights`, and `summary` in the same call — all nested under `contents`.
- **`useAutoprompt` is deprecated.** Do not include it in requests.

## Complete Examples

### Basic search with highlights

```json theme={null}
{
  "query": "recent breakthroughs in quantum computing",
  "type": "auto",
  "numResults": 5,
  "contents": {
    "highlights": true
  }
}
```

### Domain-filtered news search

```json theme={null}
{
  "query": "AI regulation policy updates",
  "type": "auto",
  "category": "news",
  "numResults": 10,
  "includeDomains": ["reuters.com", "nytimes.com", "bbc.com"],
  "startPublishedDate": "2025-01-01",
  "contents": {
    "highlights": true
  }
}
```

### Deep search with structured output

```json theme={null}
{
  "query": "compare the latest frontier AI model releases",
  "type": "deep",
  "systemPrompt": "Prefer official sources and avoid duplicate results",
  "outputSchema": {
    "type": "object",
    "required": ["models"],
    "properties": {
      "models": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name", "notable_claims"],
          "properties": {
            "name": { "type": "string" },
            "notable_claims": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
  }
}
```

### Company research

```json theme={null}
{
  "query": "agtech companies in the US that have raised series A",
  "type": "auto",
  "category": "company",
  "numResults": 10,
  "contents": {
    "highlights": true
  }
}
```

---

# Official Exa Contents API guide

Source: https://exa.ai/docs/reference/contents-api-guide-for-coding-agents.md

> ## Documentation Index
>
> Fetch the complete documentation index at: https://exa.ai/docs/llms.txt Use this file to discover all available pages before exploring further.

# Contents API Reference

> Best practices, examples, and API reference for your coding agent

## Overview

**Endpoint:** `POST https://api.exa.ai/contents`

**Auth:** Pass your API key via the `Authorization: Bearer` header. Get one at [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys)

The Contents API extracts clean, LLM-ready content from any URL. It handles JavaScript-rendered pages, PDFs, and complex layouts. Returns full text, highlights, summaries, or any combination.

## Installation

```bash theme={null}
pip install exa-py    # Python
npm install exa-js    # JavaScript
```

## Minimal Working Example

```bash theme={null}
curl -X POST "https://api.exa.ai/contents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EXA_API_KEY" \
  -d '{"urls": ["https://example.com"], "text": true}'
```

```python theme={null}
from exa_py import Exa
exa = Exa()
result = exa.get_contents(["https://example.com"], text=True)
```

```javascript theme={null}
import Exa from "exa-js";
const exa = new Exa();
const result = await exa.getContents(["https://example.com"], { text: true });
```

## Request Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `urls` | string\[] | **(required)** | Array of URLs to extract content from. Also accepts `ids` (document IDs from search results). |
| `text` | boolean or object | — | Return full page text as markdown. Object form: `{maxCharacters, includeHtmlTags, verbosity, includeSections, excludeSections}`. |
| `highlights` | boolean or object | — | Return key excerpts relevant to a query. Pass `true` for the highest-quality default. Object form: `{query, maxCharacters}` — use `query` to guide which highlights are returned, `maxCharacters` to cap the budget. |
| `summary` | boolean or object | — | Return LLM-generated summary. Object form: `{query, schema}`. |
| `maxAgeHours` | integer | — | Max age of cached content in hours. `0` = always livecrawl. `-1` = never livecrawl. Omit for default (livecrawl as fallback). |
| `livecrawlTimeout` | integer | `10000` | Timeout for livecrawling in milliseconds. Recommended: 10000-15000. |
| `subpages` | integer | `0` | Number of subpages to crawl from each URL. |
| `subpageTarget` | string or string\[] | — | Keywords to prioritize when selecting subpages. |
| `extras.links` | integer | `0` | Number of URLs to extract from each page. |
| `extras.imageLinks` | integer | `0` | Number of image URLs to extract from each page. |
| `compliance` | string | — | Enterprise-only compliance mode. Set to `"hipaa"` for HIPAA mode. Uses cache-only retrieval; summaries and livecrawl are not supported. |

### Text Object Options

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `maxCharacters` | integer | — | Character limit for returned text. |
| `includeHtmlTags` | boolean | `false` | Preserve HTML tags in output. |
| `verbosity` | string | `"compact"` | `compact`, `standard`, or `full`. Should use `maxAgeHours: 0` for fresh content. |
| `includeSections` | string\[] | — | Only include these page sections: `header`, `navigation`, `banner`, `body`, `sidebar`, `footer`, `metadata`. Should use `maxAgeHours: 0` for fresh content. |
| `excludeSections` | string\[] | — | Exclude these page sections. Same options as above. Should use `maxAgeHours: 0` for fresh content. |

### Highlights Object Options

Prefer `highlights: true` for the highest-quality default. Only supply this object when you specifically need to guide selection with a custom query or cap output size.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | string | — | Custom query that guides which highlights the LLM picks. |
| `maxCharacters` | integer | — | Cap on total highlight characters per URL. Omit unless you have a specific budget — leaving it unset gives the highest-quality default. |

### Summary Object Options

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | string | — | Custom query for the summary. |
| `schema` | object | — | JSON Schema (Draft 7) for structured summary output. |

## Content Modes

**Text** — Full page content as clean markdown. Best for deep analysis.

```json theme={null}
{ "urls": ["https://example.com"], "text": { "maxCharacters": 8000 } }
```

**Highlights** — Extractive key excerpts from the page. Best for agent workflows (10x fewer tokens). These are pulled directly from the source, not generated.

```json theme={null}
{ "urls": ["https://example.com"], "highlights": { "query": "key findings" } }
```

**Summary** — LLM-generated abstract. Supports JSON schema for structured extraction.

```json theme={null}
{
  "urls": ["https://example.com"],
  "summary": {
    "query": "Extract company information",
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "industry": { "type": "string" }
      },
      "required": ["name", "industry"]
    }
  }
}
```

You can combine all three in a single request.

## Content Freshness

| `maxAgeHours` value | Behavior |
| --- | --- |
| Omit (default) | Livecrawl only when no cached content exists. **Recommended.** |
| Positive (e.g. `24`) | Use cache if less than N hours old, otherwise livecrawl. |
| `0` | Always livecrawl, never use cache. Increases latency. |
| `-1` | Never livecrawl, cache only. Maximum speed. |

When using `maxAgeHours`, pair with `livecrawlTimeout` (10000-15000ms recommended).

## Subpage Crawling

Automatically discover and extract content from linked pages within a site.

```json theme={null}
{
  "urls": ["https://docs.example.com"],
  "subpages": 10,
  "subpageTarget": ["api", "reference", "guide"],
  "text": { "maxCharacters": 5000 }
}
```

- `subpages`: Max subpages to crawl per URL.
- `subpageTarget`: Keywords to prioritize when selecting which subpages to crawl.
- Start small (5-10) and increase if needed.

## Response Schema

```json theme={null}
{
  "requestId": "e492118ccdedcba5088bfc4357a8a125",
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com/page",
      "id": "https://example.com/page",
      "publishedDate": "2024-01-15T00:00:00.000Z",
      "author": "Author Name",
      "image": "https://example.com/image.png",
      "favicon": "https://example.com/favicon.ico",
      "text": "Full page content as markdown...",
      "highlights": ["Key excerpt from the page..."],
      "highlightScores": [0.46],
      "summary": "LLM-generated summary...",
      "subpages": [],
      "extras": {
        "links": ["https://example.com/related"]
      }
    }
  ],
  "statuses": [
    {
      "id": "https://example.com/page",
      "status": "success"
    }
  ],
  "costDollars": {
    "total": 0.003
  }
}
```

### Response Fields

| Field | Type | Description |
| --- | --- | --- |
| `requestId` | string | Unique request identifier. |
| `results` | array | List of result objects with extracted content. |
| `results[].title` | string | Page title. |
| `results[].url` | string | Page URL. |
| `results[].id` | string | Document ID (same as URL). |
| `results[].publishedDate` | string or null | Estimated publication date. |
| `results[].author` | string or null | Author if available. |
| `results[].text` | string | Full page text (if `text` requested). |
| `results[].highlights` | string\[] | Key excerpts (if `highlights` requested). |
| `results[].highlightScores` | float\[] | Cosine similarity scores for each highlight. |
| `results[].summary` | string | LLM summary (if `summary` requested). |
| `results[].subpages` | array | Nested results from subpage crawling. Same shape as results. |
| `results[].extras.links` | string\[] | Extracted links from the page. |
| `statuses` | array | Per-URL status information. Always check this for errors. |
| `statuses[].id` | string | The URL that was requested. |
| `statuses[].status` | string | `"success"` or `"error"`. |
| `statuses[].error.tag` | string | Error type (see Error Handling). |
| `statuses[].error.httpStatusCode` | integer or null | Corresponding HTTP status code. |
| `costDollars.total` | float | Total dollar cost for the request. |

## Error Handling

The endpoint returns HTTP 200 even when individual URLs fail. Per-URL errors appear in the `statuses` array.

### Per-URL Error Tags

| Tag | HTTP Code | Meaning |
| --- | --- | --- |
| `CRAWL_NOT_FOUND` | 404 | Content not found. |
| `CRAWL_TIMEOUT` | 504 | Crawl timed out fetching content. |
| `CRAWL_LIVECRAWL_TIMEOUT` | 504 | Livecrawl exceeded `livecrawlTimeout`. |
| `SOURCE_NOT_AVAILABLE` | 403 | Access forbidden. |
| `UNSUPPORTED_URL` | — | URL type not supported. |
| `CRAWL_UNKNOWN_ERROR` | 500+ | Other errors. |

### Request-Level Errors

| HTTP Status | Meaning                           |
| ----------- | --------------------------------- |
| 400         | Bad request — invalid parameters. |
| 401         | Invalid or missing API key.       |
| 422         | Validation error.                 |
| 429         | Rate limit exceeded.              |

Always check `statuses` to handle per-URL failures:

```python theme={null}
result = exa.get_contents(["https://example.com", "https://example.com/maybe-broken"])
for status in result.statuses:
    if status.status == "error":
        print(f"Failed: {status.id} - {status.error.tag}")
```

## Common Mistakes

<Warning>
  LLMs frequently generate these incorrect parameters. Do NOT use any of the following:

| Wrong | Correct |
| --- | --- |
| `useAutoprompt: true` | Remove it. `useAutoprompt` does **not exist** on the `/contents` endpoint. |
| `numSentences` | Remove it. This highlights parameter is **deprecated**. Use `highlights: true` instead. |
| `highlightsPerUrl` | Remove it. This highlights parameter is **deprecated**. Use `highlights: true` instead. |
| `livecrawl: "always"` | Use `maxAgeHours: 0` instead. The `livecrawl` parameter is **deprecated**. |
| `tokensNum` | Remove it. This parameter does **not exist**. Use `text.maxCharacters` to limit text length. |
| `stream: true` | Remove it. The `/contents` endpoint does **not** support streaming. |
| `contents: { text: ... }` | On `/contents`, `text`, `highlights`, and `summary` are **top-level** — do NOT wrap them in a `contents` object. This is different from `/search`. |

**Remember:** On the `/contents` endpoint, `text`, `highlights`, and `summary` are top-level parameters. Do NOT nest them inside a `contents` object (that nesting is only for the `/search` endpoint). </Warning>

## Patterns and Gotchas

- **Always check `statuses`.** The endpoint returns 200 even when individual URLs fail. Unchecked, you'll silently miss failed URLs.
- **Use `highlights` over `text` for agent workflows.** Highlights are 10x more token-efficient and return the most relevant excerpts.
- **Set `livecrawlTimeout` when using `maxAgeHours`.** Default is 10000ms. For slow sites, use 12000-15000ms.
- **`subpageTarget` focuses crawling.** Without it, subpage selection is best-effort. Use specific terms like `["api", "docs"]`.
- **Python SDK uses snake\_case.** `subpageTarget` → `subpage_target`, `maxAgeHours` → `max_age_hours`, `maxCharacters` → `max_characters`.
- **`urls` and `ids` are interchangeable.** Both accept URL strings. `ids` exists for backward compatibility with document IDs from search results.
- **Combine modes freely.** Request `text`, `highlights`, and `summary` in the same call for different views of the same content.

## Complete Examples

### Basic text extraction

```json theme={null}
{
  "urls": ["https://arxiv.org/abs/2301.07041"],
  "text": true
}
```

### Highlights with custom query

```json theme={null}
{
  "urls": ["https://example.com/research-paper"],
  "highlights": {
    "query": "methodology and results"
  }
}
```

### Documentation crawling

```json theme={null}
{
  "urls": ["https://platform.openai.com/docs"],
  "subpages": 15,
  "subpageTarget": ["api", "models", "embeddings"],
  "maxAgeHours": 24,
  "livecrawlTimeout": 15000,
  "text": { "maxCharacters": 5000 }
}
```

### Structured company extraction

```json theme={null}
{
  "urls": ["https://stripe.com"],
  "subpages": 8,
  "subpageTarget": ["about", "careers", "press", "blog"],
  "summary": {
    "query": "Company overview, culture, and recent news",
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "industry": { "type": "string" },
        "employee_count": { "type": "string" },
        "recent_news": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["name", "industry"]
    }
  }
}
```
