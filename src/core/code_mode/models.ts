import { z } from "zod";
import type { Config } from "../config/index.js";
import {
  openRouterModels,
  requestOpenRouterChat,
  requestOpenRouterDecisions,
} from "../models/openrouter.js";
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
});

export function createModelsCapability(
  backend: ToolExecutionBackend,
  config: Config,
  fetchImpl?: typeof fetch,
): CodeModeCapability {
  return {
    name: "models",
    description:
      "Standalone OpenRouter inference for text or media analysis and typed classification, scoring, or verification. Use for focused tasks with explicit inputs, without conversation context or agent tools.",
    documentation: `## tau.models

- await tau.models.list() returns { chat: Model[], decisions: Model[] }. Each model has id, inputs, reasoning, and role. Only listed model IDs and supported reasoning efforts/modalities are accepted.
- await tau.models.chat({ model, prompt, system?, reasoning?, attachments? }) performs one nonstreaming request. No conversation, tool execution, or implicit system prompt is supplied.
- Attachments are ordered objects: { type: "image" | "audio" | "video", path } OR { type, data: paddedBase64, mimeType }. Never supply both forms. File paths resolve from the current working directory. Inline MIME types must match actual bytes. Audio/video require ffprobe on PATH.
- Chat returns requested_model, model, answer (string or null), finish_reason (stop, length, content_filter), and optional id, provider, refusal, native_finish_reason, usage. Inspect finish_reason and refusal: a length result is incomplete and content_filter or refusal is not a completed answer.
- await tau.models.decisions({ model, state, questions }) returns requested_model, model, answers, usage and optional id/provider. state is a string, object, or array. questions maps names to { type: "noul", instructions, criteria?: { true, false } }, { type: "choice", instructions, criteria: { category: guidance } }, or { type: "score", instructions, criteria: [guidance, ...] }. Guidance may be a string, object, or array (choice criteria may also be null). noul answers are probabilities, choice answers name a category, and score answers are positions in the ordered rubric. Answers are advisory, not permission checks.

Only explicitly supplied inputs are sent. Credentials remain outside the sandbox. Provider usage metadata is returned but does not contribute to session cost or usage logs. Requests may incur external charges even if the program later fails. There are no automatic retries or model substitutions. No output token cap is sent. Limits: text/decisions input 1 MB; 16 attachments including at most 4 audio and 1 video; image 5 MB, one frame, 8000 pixels per edge and 32 megapixels; audio/video 12 MB each, WAV PCM16/MP3 or H.264 MP4 with optional AAC, 600 seconds combined; encoded request 20 MB, response 8 MB.`,
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
            mediaAdapter: {
              readFile: async (path, limit) => {
                context.signal.throwIfAborted();
                const file = await backend.readFileBinary(path, { maxBytes: limit });
                context.signal.throwIfAborted();
                return file.content;
              },
              probe: async (bytes, format) => {
                const result = await backend.runNodeScript(probeScript, [], {
                  signal: context.signal,
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
            },
          },
        );
      },
      decisions: async (args, context) => {
        const [input] = z.tuple([decisionOptions]).parse(args);
        return await requestOpenRouterDecisions(
          input.model,
          { state: input.state, questions: input.questions },
          { config, signal: context.signal, fetchImpl },
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
