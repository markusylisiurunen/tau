# @tau/models

Call a model for focused analysis, extraction, or typed judgments. Each call is stateless and sees only what you pass. `chat` returns text or structured output, and `decisions` answers named questions with typed values such as probabilities and scores.

```js
import { printText } from "@tau/core";
import { chat, list } from "@tau/models";

const { chat: models } = await list();
const model = models.find(({ inputs }) => inputs.includes("image"));
if (!model) throw new Error("No image model available");
const result = await chat([{ role: "user", content: [
  { type: "text", text: "What error does this screenshot show?" },
  { type: "image", path: "screenshot.png" },
] }], { model: model.id });
printText(result.answer ?? result.status);
```

## API

```ts
function list(): Promise<{ chat: ModelInfo[]; decisions: ModelInfo[] }>;
function chat(prompt: string | Message[], options: ChatOptions): Promise<ChatResult>;
function decisions(state: Guidance, options: DecisionOptions): Promise<DecisionResult>;

type ModelInfo = {
  id: string;
  inputs: string[]; // such as "text", "image", "audio", "video"
  reasoning: string[]; // accepted reasoning settings, empty when there are none
  role: string; // what the model is good for
};

type Message =
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | Media> }
  | { role: "assistant"; content: string };
type Media = { type: "image" | "audio" | "video" } & ({ path: string } | { bytes: Uint8Array });

type ChatOptions = {
  model: string; // an ID from list().chat
  system?: string;
  reasoning?: string;
  schema?: Record<string, JsonValue>; // JSON Schema for a structured answer
};
type ChatResult = {
  status: "complete" | "incomplete" | "refused";
  answer: string | JsonValue | null; // null unless complete; parsed JSON with a schema
  usage?: Usage;
};

type DecisionOptions = {
  model: string; // an ID from list().decisions
  questions: Record<string, Question>;
  attachments?: Media[]; // up to 64
};
type Question =
  | { type: "noul"; instructions: Guidance; criteria?: { true: Guidance; false: Guidance } }
  | { type: "choice"; instructions: Guidance; criteria: Record<string, Guidance | null> }
  | { type: "score"; instructions: Guidance; criteria: Guidance[] }; // ordered, lowest first
type Guidance = string | JsonValue[] | Record<string, JsonValue>; // text or JSON
type DecisionResult = { answers: Record<string, Answer>; usage: Usage };
type Answer =
  | { type: "noul"; noul: number } // probability from 0 to 1 that the condition holds
  | { type: "choice"; choice: string; confidence?: number }
  | { type: "score"; score: number; confidence?: number }; // position on the criteria, can be fractional

type Usage = { inputTokens: number; outputTokens: number; cost?: number };
```

## Models and media

Every call needs a model ID from the matching list, and each model's `role` says what it suits. Listing runs no model.

Media paths resolve from the working directory. Prefer paths for large media, because bytes pass through the program. Tau detects each file's format and rejects media the model cannot take.

## Answers

With `schema`, Tau requests structured output and parses the answer, but does not check it against the schema. `decisions` answers each question under its name. Check an answer's `type` before reading its field.

```js
import { input, printText } from "@tau/core";
import { decisions, list } from "@tau/models";

const { decisions: [model] } = await list();
if (!model) throw new Error("No decision model available");
const { answers } = await decisions({ ticket: input.ticket }, {
  model: model.id,
  questions: {
    urgent: { type: "noul", instructions: "The customer cannot use the product at all." },
    area: { type: "choice", instructions: "Which area the ticket is about.", criteria: { billing: null, login: null, other: null } },
  },
});
const { urgent, area } = answers;
if (urgent.type === "noul" && area.type === "choice") {
  printText(`${area.choice}, urgent with probability ${urgent.noul.toFixed(2)}`);
}
```

## Errors

| `code` | Meaning |
| --- | --- |
| `unavailable` | No model service key is configured. |

Other request failures throw without a `code` and are not retried, as do answers that are missing or not valid JSON.
