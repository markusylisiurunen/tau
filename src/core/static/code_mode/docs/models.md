# @tau/models

Use standalone model calls for focused analysis, extraction, or typed judgments. Calls are stateless and see only the inputs you supply. Tau handles routing.

`list()` returns `{ chat, decisions }`. Each list contains model IDs, supported `inputs`, `reasoning` settings, and a short description of the model's role. Select an explicit ID from the appropriate list. Listing does not run inference.

## Chat

```js
import { chat } from "@tau/models";

const result = await chat("What does HTTP 304 mean?", {
  model: "google/gemini-3.8-flash",
});
```

`chat(promptOrMessages, { model, system?, reasoning?, schema? })` takes a prompt string or an ordered array of `{ role, content }` messages. A string is shorthand for one user message. The roles are `"user"` and `"assistant"`. User content can be a string or an ordered array of parts:

```ts
type Media = { type: "image" | "audio" | "video" } & (
  | { path: string }
  | { bytes: Uint8Array }
);
type Part = { type: "text"; text: string } | Media;
```

Paths resolve from the working directory and avoid transferring large payloads through the program. Tau detects the media format and rejects inputs the selected model cannot handle. Assistant content is a string.

The result has `{ status, answer, usage? }`. Read `answer` when `status` is `"complete"`. The answer is a string unless you supply a JSON Schema as `schema`. With a schema, Tau requests structured output and parses the answer as JSON. Invalid JSON throws. Tau trusts inference to enforce the schema. `"incomplete"` and `"refused"` return `answer: null`. Request failures throw and are not retried automatically.

## Decisions

`decisions(state, { model, questions, attachments? })` asks several named questions about the same supplied state. `state` is text, a JSON object, or a JSON array. Attachments use the same media types as chat. Each question has `type` and `instructions`, plus `criteria` for choice and score questions:

- `noul`: A binary evaluation. The answer's `noul` field is the probability (0 to 1) that the condition holds. Optional criteria describe `true` and `false`.
- `choice`: Select one named category. Pass a map from category names to criteria. The answer's `choice` field gives the selected name.
- `score`: Rate against an ordered array of criteria. The answer's `score` field is a position on that scale, starting at 0 and potentially fractional.

The result is `{ answers, usage? }`. Answers are keyed by question name. Missing or invalid answers throw. Inspect the returned usage when the script needs to account for model calls.
