# @tau/models

Call a model for focused analysis, extraction, or typed judgments, or generate an image or speech. Each call is stateless and sees only what you pass. `chat` returns text or structured output, and `decisions` answers named questions with typed values such as probabilities and scores. `generateImage` and `generateSpeech` write one file each.

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
function list(): Promise<{
  chat: ModelInfo[];
  decisions: ModelInfo[];
  image: Array<{ id: string }>;
  speech: Array<{ id: string }>;
}>;
function chat(prompt: string | Message[], options: ChatOptions): Promise<ChatResult>;
function decisions(state: Guidance, options: DecisionOptions): Promise<DecisionResult>;
function generateImage(prompt: string, options: ImageOptions): Promise<ImageResult>;
function generateSpeech(script: Script, options: SpeechOptions): Promise<SpeechResult>;
function listVoices(options: VoiceOptions): Promise<VoicePage>;

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

Every call needs a model ID from the matching list, and each chat and decision model's `role` says what it suits. Listing runs no model and needs no key.

`chat` and `decisions` need an OpenRouter key. Image models need an OpenAI or Google key, depending on the model, and speech needs an ElevenLabs key.

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

## Images

```ts
type ImageOptions = {
  model: string; // an ID from list().image
  outputPath: string; // its extension must match settings.format
  references?: string[]; // PNG, JPEG, or WebP images to edit or draw from, in order
  settings?: OpenAISettings | GoogleSettings; // only the fields of the model's provider
};
type ImageResult = { outputPath: string; artifacts: string; usage: JsonValue | null };

type OpenAISettings = { // gpt-image-2.6-flare, gpt-image-2.6-sunburst
  size?: string; // "auto" or "WIDTHxHEIGHT"
  quality?: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
  complexity?: "low" | "medium" | "high";
  background?: "auto" | "opaque" | "transparent"; // transparent needs png or webp
  format?: "png" | "jpeg" | "webp"; // default "png"
  compression?: number; // 0 to 100, jpeg or webp only
};
type GoogleSettings = { // gemini-nano-banana-2.1
  aspectRatio?: string; // such as "1:1", "16:9", "21:9", or "8:1"
  resolution?: "1K" | "2K" | "4K";
  thinking?: "minimal" | "medium" | "high";
  format?: "png";
};
```

Start with `gpt-image-2.6-flare` at `quality: "medium"`. Use `gpt-image-2.6-sunburst` for demanding edits, and `gemini-nano-banana-2.1` for very wide images. OpenAI sizes use multiples of 16, at most 3840 per side, an aspect ratio between 1:3 and 3:1, and 655,360 to 8,294,400 pixels in total, such as `"1024x1024"` or `"1536x1024"`. `complexity: "low"` suits focused edits, and `"medium"` or `"high"` suit dense text and layouts. OpenAI models take up to 16 references, and Google up to 14 references totaling 19 MB.

The model sees only the prompt and references, so describe what to keep when editing:

```js
import { printText } from "@tau/core";
import { generateImage } from "@tau/models";

const { outputPath } = await generateImage(
  "Give the otter a blue scarf. Keep its face, pose, and background.",
  {
    model: "gpt-image-2.6-flare",
    outputPath: "art/otter-scarf.png",
    references: ["art/otter.png"],
    settings: { quality: "high", complexity: "low", background: "transparent" },
  },
);
printText(outputPath);
```

At 1024x1024, an OpenAI image costs about $0.03 at `low`, $0.04 at `medium`, $0.05 at `high`, and $0.21 at `max`. A Google image costs about $0.03 at 1K, $0.05 at 2K, and $0.11 at 4K. Input and thinking cost extra.

## Speech

```ts
type Script = {
  voices: Record<string, string>; // speaker name to voice ID
  chunks: Array<Array<{ speaker: string; text: string }>>;
};
type SpeechOptions = {
  model: string; // an ID from list().speech
  outputPath: string; // must end in .wav
};
type SpeechResult = { outputPath: string; artifacts: string; batches: number };

type VoiceOptions = { model: SpeechOptions["model"]; cursor?: string; limit?: number }; // limit 1 to 100, default 100
type VoicePage = { voices: Array<{ id: string; name: string }>; nextCursor: string | null };
```

`generateSpeech` writes one mono 24 kHz 16-bit WAV. Use `eleven_v4_turbo` for lower latency and `eleven_v4` for the highest quality. Narration uses one speaker, and dialogue uses several. A script uses at most 10 voices, and each chunk holds at most 2,000 characters, including tags. Break chunks at natural pauses, because Tau sends consecutive chunks together when they fit and never splits one. Get voice IDs from `listVoices`, and pass `nextCursor` as `cursor` for the next page.

```js
import { generateSpeech } from "@tau/models";

await generateSpeech({
  voices: { host: "VOICE_ID_A", guest: "VOICE_ID_B" },
  chunks: [
    [
      { speaker: "host", text: "[calm] What are we exploring today?" },
      { speaker: "guest", text: "How a forest changes through the seasons." },
    ],
    [{ speaker: "host", text: "Let's begin with spring." }],
  ],
}, { model: "eleven_v4_turbo", outputPath: "audio/forest.wav" });
```

Tags in square brackets guide how text is spoken and are not read aloud. Tags describe sound, so avoid visual actions, and results vary by voice and language. For example:

| Use | Tag |
| --- | --- |
| Everyday reply | `[Brisk but relaxed, speaking naturally to a colleague]` |
| Step-by-step explanation | `[Calm and clear, measured pace, brief pauses between steps]` |
| Story narration | `[Warm, expressive storytelling, unhurried pace]` |
| Short cues | `[curious]`, `[whispering]`, `[laughs]`, `[short pause]` |

Per 1,000 characters, `eleven_v4_turbo` costs about $0.04 and `eleven_v4` about $0.08. Thirty minutes of speech is roughly 27,000 characters.

## Generated files

Neither `outputPath` nor `<outputPath>.parts` may exist yet, so a generation never replaces a file. The `.parts` directory, returned as `artifacts`, stays after the call and holds a `manifest.json`. For speech, the manifest contains the script text, so delete the directory when the script is private.

When generation fails, the error names the `.parts` directory and what it holds. Recover from it instead of generating again:

- Image: `original.bin` is the provider's image. If the request succeeded and only saving failed, convert or copy that file.
- Speech: a `batch-0001.pcm` or later numbered file holds a completed batch, even if its manifest metadata is missing. Generate only the unfinished chunks to a new path. Then join the PCM files in order with Bash, leaving out `.partial` files, and convert the result with `ffmpeg -f s16le -ar 24000 -ac 1 -i complete.pcm complete.wav`.

## Errors

| `code` | Meaning |
| --- | --- |
| `unavailable` | `chat` or `decisions` without an OpenRouter key. |

Other failures throw without a `code`, such as a missing image or speech key, settings the model does not support, or an answer that is missing or not valid JSON. Tau rejects invalid arguments and settings before sending a request. It never retries a request, because the provider may already have charged for it, and calling again may be charged again.
