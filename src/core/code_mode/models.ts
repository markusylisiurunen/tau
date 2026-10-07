import { z } from "zod";
import type { Config } from "../config/index.js";
import {
  openRouterModels,
  requestOpenRouterChat,
  requestOpenRouterDecisions,
} from "../models/openrouter.js";
import type { OpenRouterMediaAdapter } from "../models/openrouter_media.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { CodeModeCapability } from "./capability.js";

const kind = z.enum(["image", "audio", "video"]);
const attachment = z.union([
  z.strictObject({ type: kind, path: z.string().min(1) }),
  z.strictObject({ type: kind, data: z.string().min(1), mimeType: z.string().min(1) }),
]);
const chatOptions = z.strictObject({
  model: z.string().min(1),
  prompt: z.string().min(1),
  system: z.string().min(1).optional(),
  reasoning: z.string().optional(),
  attachments: z.array(attachment).max(16).default([]),
});
const decisionOptions = z.strictObject({
  model: z.string().min(1),
  state: z.unknown(),
  questions: z.unknown(),
  attachments: z
    .array(
      attachment.refine((item) => item.type === "image", {
        message: "decisions only support image attachments",
      }),
    )
    .max(16)
    .default([]),
});

export function createModelsCapability(
  backend: ToolExecutionBackend,
  config: Config,
  fetchImpl?: typeof fetch,
): CodeModeCapability {
  function mediaAdapter(signal: AbortSignal): OpenRouterMediaAdapter {
    return {
      readFile: async (path, limit) => {
        signal.throwIfAborted();
        const file = await backend.readFileBinary(path, { maxBytes: limit });
        signal.throwIfAborted();
        return file.content;
      },
      probe: async (bytes, format) => {
        const result = await backend.runNodeScript(probeScript, [], {
          signal,
          timeoutMs: 20_000,
          maxCaptureBytes: 1_000_000,
          stdin: Buffer.from(JSON.stringify({ data: bytes.toString("base64"), format })),
        });
        if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted)
          throw new Error(
            "failed to validate media; ensure ffprobe is installed and the media is valid",
          );
        return JSON.parse(result.stdout);
      },
    };
  }

  return {
    name: "models",
    description:
      "Call AI models through OpenRouter for focused, standalone tasks. Example uses include extraction and summarization, image/audio/video analysis, typed classification or scoring, and second opinions. Each call uses only explicitly supplied inputs, without conversation context or agent tools.",
    documentation: `# tau.models

Use AI models for focused tasks with explicitly supplied inputs. Calls do not inherit the conversation, persona, tools, or an implicit system prompt. Use chat for text/media understanding and free-form answers; use decisions for named classification, probability, or scoring questions.

## Interface

\`\`\`ts
type ModelsApi = {
  list(): Promise<ModelList>;
  chat(options: ChatOptions): Promise<ChatResult>;
  decisions(options: DecisionOptions): Promise<DecisionResult>;
};
\`\`\`

## \`tau.models.list()\`

Takes no arguments and returns the fixed model catalog:

\`\`\`ts
type Model = {
  id: string;
  inputs: string[];
  reasoning: string[];
  role: string;
};
type ModelList = { chat: Model[]; decisions: Model[] };
\`\`\`

Listing makes no provider request and requires no credentials. Select an exact ID from the appropriate list using its input modalities and role guidance. Only listed models and reasoning efforts are accepted. There is no default model, automatic substitution, or live discovery. Reuse a catalog already visible in the conversation.

## \`tau.models.chat(options)\`

Send one nonstreaming request.

\`\`\`ts
type Attachment = { type: "image" | "audio" | "video" } & (
  | { path: string; data?: never; mimeType?: never }
  | { data: string; mimeType: string; path?: never }
);
type ChatOptions = {
  model: string;
  prompt: string;
  system?: string;
  reasoning?: string;
  attachments?: Attachment[];
};
type ChatResult = {
  requested_model: string;
  model: string;
  answer: string | null;
  finish_reason: "stop" | "length" | "content_filter";
  id?: string;
  provider?: string;
  refusal?: string | null;
  native_finish_reason?: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number | null;
    [key: string]: unknown;
  };
};
\`\`\`

\`prompt\` and optional \`system\` must be nonblank. Omitted attachments default to an empty array. Omitted system instructions send no system message. Omitted reasoning leaves that setting to the provider; it does not necessarily disable reasoning. Reasoning traces are not returned as answer text.

Attachments follow the prompt in array order. Paths resolve from the current working directory. Inline data must be canonical padded base64 with a MIME type matching the actual bytes. Supply exactly one source form per attachment, not a URL. Audio/video require ffprobe on PATH. Unsupported media fail rather than being resized, converted, transcribed, or split automatically.

\`requested_model\` records the selected ID; \`model\` records the provider's returned ID. Inspect completion status before using the answer:

- \`stop\` with no refusal is complete.
- \`length\` is incomplete, even if answer text is empty.
- \`content_filter\` or a nonempty \`refusal\` is refusal, not a completed answer.

These statuses resolve normally. Invalid responses, unexpected tool calls, and a normal stop with neither answer nor refusal throw. No output token cap is sent; provider and model limits still apply.

For example, select a listed image-capable model and supply an existing screenshot:

\`\`\`js
const catalog = await tau.models.list();
const model = catalog.chat.find(item => item.id === "openai/gpt-6-luna");
if (!model || !model.inputs.includes("image")) throw new Error("model unavailable for images");
const result = await tau.models.chat({
  model: model.id,
  prompt: "Extract the error message and describe the visible failure.",
  attachments: [{ type: "image", path: "./screenshot.png" }],
});
if (result.finish_reason !== "stop" || result.refusal || !result.answer)
  throw new Error("model did not produce a complete answer");
printText(result.answer);
\`\`\`

## \`tau.models.decisions(options)\`

Ask several named questions about one supplied state. Independent questions can share a request; dependent questions require separate calls.

\`\`\`ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Guidance = string | Json[] | { [key: string]: Json };
type Question =
  | { type: "noul"; instructions: Guidance; criteria?: { true: Guidance; false: Guidance } }
  | { type: "choice"; instructions: Guidance; criteria: Record<string, Guidance | null> }
  | { type: "score"; instructions: Guidance; criteria: Guidance[] };
type DecisionOptions = {
  model: string;
  state: Guidance;
  questions: Record<string, Question>;
  attachments?: Array<Attachment & { type: "image" }>;
};
type Answer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence?: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, Guidance>;
    };
type DecisionResult = {
  requested_model: string;
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number; [key: string]: unknown };
  id?: string;
  provider?: string;
};
\`\`\`

\`questions\` must be nonempty with nonempty names. Choice criteria require at least one category; score criteria require a nonempty ordered rubric. Unknown question fields and the question/category name \`__proto__\` are rejected. Every question receives an answer of the corresponding type:

- \`noul\`: probability from 0 to 1, not a boolean.
- \`choice\`: one supplied category; optional confidence and category probabilities are from 0 to 1.
- \`score\`: position from 0 to the final rubric index, possibly fractional. Distribution and legend keys are rubric-index strings. Optional confidence and probabilities are from 0 to 1.

Prefer \`openai/gpt-6-luna-decisions\` for decisions, including text, JSON, and image-based judgments. Choose \`typesafe/jev-1.13\` for high-volume text or JSON decisions when cost is the priority.

Luna supports at most 200 questions, 255 categories per choice question, and 2–10 rubric levels per score question. These limits are checked before sending the request. Jev also accepts a single-level score rubric.

Luna accepts up to 16 PNG/JPEG/WebP images. Supply them through \`attachments\`, using the same path or inline forms as chat images. Describe what to check in \`questions\`. Images follow \`state\` in attachment order and retain their original bytes. Objects and arrays in \`state\` are sent as JSON text, so image URLs inside \`state\` are treated as text.

The image limits below apply to decisions too. Jev accepts no attachments. Neither decision model accepts audio or video. Omitting \`attachments\` sends no images.

Negative judgments and low confidence are normal results. Refusals and responses with mismatched names, types, categories, or ranges throw. The tool returns the model's answers without adding decision thresholds or prose explanations.

\`\`\`js
const catalog = await tau.models.list();
const model = catalog.decisions.find(item => item.id === "openai/gpt-6-luna-decisions");
if (!model) throw new Error("decision model unavailable");
const result = await tau.models.decisions({
  model: model.id,
  state: { ticket: "Checkout crashes when I click Pay." },
  questions: {
    is_bug: { type: "noul", instructions: "Does this describe broken behavior?" },
    urgency: {
      type: "score",
      instructions: "How urgent is this issue?",
      criteria: ["Can wait", "Fix soon", "Blocking revenue"],
    },
  },
});
printText(JSON.stringify(result.answers));
\`\`\`

Inspect an existing screenshot:

\`\`\`js
const result = await tau.models.decisions({
  model: "openai/gpt-6-luna-decisions",
  state: "Check the checkout screen for visible errors.",
  questions: {
    has_error: { type: "noul", instructions: "Is an error message visible?" },
  },
  attachments: [{ type: "image", path: "./checkout.png" }],
});
printText(JSON.stringify(result.answers));
\`\`\`

## Limits and failures

Byte limits below use decimal bytes:

- Each prompt/system input and the decisions input: 1,000,000 UTF-8 bytes.
- Attachments: 16 total, including at most 4 audio and 1 video.
- Each image: 5,000,000 bytes; PNG/JPEG/WebP, one frame, at most 8,000 pixels per edge and 32 megapixels.
- Each audio/video: 12,000,000 bytes; single-stream PCM16 WAV or MP3, or H.264 MP4 up to 3840×2160 with optional AAC. Positive known duration, at most 600 seconds combined.
- Encoded request: 20,000,000 bytes including base64 and text; response: 8,000,000 bytes.

Validation, authentication, service failures, and malformed responses throw. There are no automatic retries. A failed or interrupted request may already be billable: inspect the outcome before retrying. Returned usage contains provider-reported metadata, not estimates; external charges are not included in session cost or usage logs.`,
    api: {
      list: (args) => {
        z.tuple([]).parse(args);
        return structuredClone(openRouterModels);
      },
      chat: async (args, context) => {
        const [input] = z.tuple([chatOptions]).parse(args);
        return await requestOpenRouterChat(
          {
            ...input,
            attachments: input.attachments.map(({ type, ...source }) => ({
              kind: type,
              ...source,
            })),
          },
          {
            config,
            signal: context.signal,
            fetchImpl,
            mediaAdapter: mediaAdapter(context.signal),
          },
        );
      },
      decisions: async (args, context) => {
        const [input] = z.tuple([decisionOptions]).parse(args);
        return await requestOpenRouterDecisions(
          {
            model: input.model,
            value: { state: input.state, questions: input.questions },
            attachments: input.attachments.map(({ type, ...source }) => ({
              kind: type,
              ...source,
            })),
          },
          { config, signal: context.signal, fetchImpl, mediaAdapter: mediaAdapter(context.signal) },
        );
      },
    },
  };
}

const probeScript = `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tau-model-media-"));
try {
  const file = path.join(directory, "input");
  fs.writeFileSync(file, Buffer.from(input.data, "base64"), { mode: 0o600 });
  process.stdout.write(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-f", input.format, "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file], { timeout: 15000, maxBuffer: 1000000 }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
`;
