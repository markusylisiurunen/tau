# @tau/models

Use standalone model calls for focused analysis, extraction, or typed judgments. Each call is stateless and sees only the inputs you pass.

`list()` returns `{ chat, decisions }`, the models available to each function, with their IDs, supported `inputs`, `reasoning` settings, and a short description of each model's role. Listing runs no model, and every call needs an explicit model ID from the matching list.

## Chat

```js
import { chat, list } from "@tau/models";

const { chat: models } = await list();
const model = models.find(({ inputs }) => inputs.includes("text"));
if (!model) throw new Error("No text model available");

const result = await chat("What does HTTP 304 mean?", {
  model: model.id,
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

Paths resolve from the working directory. Prefer them for large media, because bytes pass through the program. Tau detects the media format and rejects media the selected model cannot handle. Assistant content is a string.

The result is `{ status, answer, usage? }`. `status` is `"complete"`, `"incomplete"`, or `"refused"`, and `answer` is `null` unless the call completed. The answer is a string, or with a JSON Schema in `schema`, the parsed JSON value. Tau requests structured output but does not check the value against the schema, and invalid JSON throws. Request failures throw and are not retried.

## Decisions

`decisions(state, { model, questions, attachments? })` asks several named questions about the same state. `state` is text, a JSON object, or a JSON array. Attachments use the same media types as chat. Each question has `type` and `instructions`, plus `criteria` for choice and score questions:

- `noul`: a yes-or-no judgment. The answer's `noul` field is the probability, from 0 to 1, that the condition holds. Optional criteria describe `true` and `false`.
- `choice`: one named category. Pass a map from category names to criteria. The answer's `choice` field is the selected name.
- `score`: a rating against an ordered array of criteria. The answer's `score` field is a position on that scale, starting at 0, and can be fractional.

The result is `{ answers, usage? }`, with answers keyed by question name. Each answer's `type` matches its question, so check `type` before reading its field:

```ts
type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence?: number }
  | { type: "score"; score: number; confidence?: number };
```

Missing or invalid answers throw.
