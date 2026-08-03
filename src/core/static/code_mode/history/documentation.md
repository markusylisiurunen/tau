The one-shot JavaScript runtime provides these globals:

- `history.search(options)`: find session descriptors by text, exact attributes, or recency.
- `history.read(options)`: read one bounded page from a selected session's active transcript.
- `docs`: this document.
- `console`: program output. Only text written through console methods is returned; return values are ignored.

Top-level `await` is supported. Calls may run concurrently with `Promise.all`.

## `history.search(options)`

```js
const page = await history.search({
  query: "session history design",
  attributes: { repository: "github.com/markusylisiurunen/tau" },
  limit: 10,
});

for (const session of page.sessions) {
  console.log(`${session.sessionId}: ${session.digest?.title ?? "untitled"}`);
  if (session.digest?.summary) console.log(session.digest.summary);
  for (const snippet of session.snippets) console.log(`- ${snippet}`);
}
```

All fields are optional. `limit` defaults to 10 and is bounded to 100. With neither `query` nor `attributes`, results are the most recently updated sessions. Attribute filters are exact string matches. Text search covers generated titles and summaries when available as well as transcript content. Use the opaque `nextCursor` in another call to continue.

Search returns:

```js
{
  sessions: [{
    sessionId: string,
    attributes: Record<string, string>,
    createdAt: number,
    updatedAt: number,
    digest?: {
      title: string,
      summary: string,
      updatedThroughEntryId: string,
    },
    snippets: string[],
  }],
  nextCursor?: string,
}
```

Digests are derived, replaceable metadata and may be absent or stale. `updatedThroughEntryId` identifies the latest transcript entry covered by the digest.

## `history.read(options)`

```js
const page = await history.read({ sessionId, limit: 50 });
const conversational = page.entries.filter((entry) => entry.type !== "tool");
console.log(conversational);
```

`sessionId` is required. `limit` defaults to 50 and is bounded to 100. Use the opaque `nextCursor` to continue in transcript order.

The transcript is a flat list. Text entries have `type: "user" | "assistant"` and `content`. Tool entries have `type: "tool"`, `name`, `arguments`, `result`, and `outcome`. Every entry also has `id`, `sourceIds`, and `timestamp`. A transcript represents the active conversation, so content removed by rewind is absent. Compaction does not remove original transcript entries.

## Filtering and pagination

Ordinary JavaScript should do further projection and filtering:

```js
let cursor;
const tools = [];
do {
  const page = await history.read({ sessionId, cursor, limit: 100 });
  tools.push(...page.entries.filter((entry) => entry.type === "tool"));
  cursor = page.nextCursor;
} while (cursor && tools.length < 20);

console.log(tools.slice(0, 20));
```

Keep retrieval focused. Search concise descriptors first and read only sessions and pages relevant to the current task.
