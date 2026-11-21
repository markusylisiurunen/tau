import { createHash } from "node:crypto";
import { z } from "zod";
import { type Availability, requireCapability } from "../agent/capabilities.js";
import type { ApiKeysConfig } from "../config/index.js";
import { generateImage, imageModels, imageOptions } from "../media/image.js";
import {
  generateSpeech,
  listVoices,
  speechDocument,
  speechModels,
  speechOptions,
  voiceOptions,
} from "../media/speech.js";
import {
  openRouterModels,
  requestOpenRouterChat,
  requestOpenRouterDecisions,
} from "../models/openrouter.js";
import type { OpenRouterAttachment, OpenRouterMediaAdapter } from "../models/openrouter_media.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { type CodeModePackage, definePackage, method } from "./package.js";

const kind = z.enum(["image", "audio", "video"]);
const attachment = z.union([
  z.strictObject({ type: kind, path: z.string().min(1) }),
  z.strictObject({ type: kind, bytes: z.instanceof(Uint8Array) }),
]);
const textPart = z.strictObject({ type: z.literal("text"), text: z.string().min(1) });
const userContent = z.union([z.string().min(1), z.array(z.union([textPart, attachment])).min(1)]);
const chatInput = z.union([
  z.string().min(1),
  z
    .array(
      z.discriminatedUnion("role", [
        z.strictObject({ role: z.literal("user"), content: userContent }),
        z.strictObject({ role: z.literal("assistant"), content: z.string().min(1) }),
      ]),
    )
    .min(1),
]);
const chatOptions = z.strictObject({
  model: z.string().min(1),
  system: z.string().min(1).optional(),
  reasoning: z.string().optional(),
  schema: z.record(z.string(), z.json()).optional(),
});
const decisionOptions = z.strictObject({
  model: z.string().min(1),
  questions: z.record(z.string(), z.unknown()),
  attachments: z.array(attachment).max(64).default([]),
});

function providerAttachment(part: z.infer<typeof attachment>): OpenRouterAttachment {
  return "path" in part
    ? { kind: part.type, path: part.path }
    : { kind: part.type, data: Buffer.from(part.bytes).toString("base64") };
}

export function createModelsPackage(
  backend: ToolExecutionBackend,
  config: ApiKeysConfig,
  availability: Availability,
  fetchImpl?: typeof fetch,
): CodeModePackage {
  function mediaAdapter(signal: AbortSignal): OpenRouterMediaAdapter {
    return {
      readFile: async (path, limit) => {
        signal.throwIfAborted();
        const file = await backend.readFileBinary(path, { maxBytes: limit });
        signal.throwIfAborted();
        return file.content;
      },
      probe: async (bytes, format, path) => {
        let stagedPath: string | undefined;
        try {
          if (path === undefined) {
            const staged = await backend.runNodeScript(stageScript, [], { signal });
            if (staged.exitCode !== 0 || staged.truncated || staged.timedOut || staged.aborted)
              throw new Error("failed to stage inline media; use an attachment path");
            stagedPath = z.string().min(1).parse(JSON.parse(staged.stdout));
            await backend.writeFileBinary(stagedPath, bytes);
            path = stagedPath;
          }
          const result = await backend.runNodeScript(probeScript, [], {
            signal,
            timeoutMs: 20_000,
            maxCaptureBytes: 1_000_000,
            stdin: Buffer.from(
              JSON.stringify({
                path,
                format,
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              }),
            ),
          });
          if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted)
            throw new Error(
              "failed to validate media; ensure ffprobe is installed and the media is valid and unchanged",
            );
          return JSON.parse(result.stdout);
        } finally {
          if (stagedPath !== undefined) {
            await backend.runNodeScript(
              'require("node:fs").rmSync(require("node:path").dirname(process.argv[1]), { recursive: true, force: true });',
              [stagedPath],
              { timeoutMs: 20_000 },
            );
          }
        }
      },
    };
  }

  return definePackage(
    "models",
    "Make one-off LLM calls to analyze text and media, return structured output, and make typed decisions. Generate images and speech.",
    {
      generateImage: method(
        z.tuple([z.string().refine((s) => s.trim().length > 0), imageOptions]),
        ([prompt, opts], { signal }) =>
          generateImage(prompt, opts, { backend, config, signal, fetchImpl }),
      ),
      generateSpeech: method(
        z.tuple([speechDocument, speechOptions]),
        ([script, opts], { signal }) =>
          generateSpeech(script, opts, { backend, config, signal, fetchImpl }),
      ),
      listVoices: method(z.tuple([voiceOptions]), ([opts], { signal }) =>
        listVoices(opts, { backend, config, signal, fetchImpl }),
      ),
      list: method(z.tuple([]), () => ({
        image: imageModels.map((id) => ({ id })),
        speech: speechModels.map((id) => ({ id })),
        ...Object.fromEntries(
          Object.entries(openRouterModels).map(([operation, models]) => [
            operation,
            models.map(({ id, inputs, reasoning, role }) => ({ id, inputs, reasoning, role })),
          ]),
        ),
      })),
      chat: method(z.tuple([chatInput, chatOptions]), async ([input, options], context) => {
        requireCapability(availability, "Model inference");
        const turns =
          typeof input === "string" ? [{ role: "user" as const, content: input }] : input;
        const result = await requestOpenRouterChat(
          {
            ...options,
            messages: turns.map((turn) =>
              turn.role === "assistant"
                ? turn
                : {
                    role: "user",
                    content:
                      typeof turn.content === "string"
                        ? [{ type: "text", text: turn.content }]
                        : turn.content.map((part) =>
                            part.type === "text" ? part : providerAttachment(part),
                          ),
                  },
            ),
          },
          {
            config,
            signal: context.signal,
            fetchImpl,
            mediaAdapter: mediaAdapter(context.signal),
          },
        );
        const status =
          result.refusal || result.finish_reason === "content_filter"
            ? "refused"
            : result.finish_reason === "length"
              ? "incomplete"
              : "complete";
        const usage = result.usage;
        return {
          status,
          answer: status === "complete" ? result.answer : null,
          ...(usage
            ? {
                usage: {
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
                },
              }
            : {}),
        };
      }),
      decisions: method(z.tuple([z.json(), decisionOptions]), async ([state, options], context) => {
        requireCapability(availability, "Model inference");
        const { answers, usage } = await requestOpenRouterDecisions(
          {
            model: options.model,
            value: { state, questions: options.questions },
            attachments: options.attachments.map(providerAttachment),
          },
          {
            config,
            signal: context.signal,
            fetchImpl,
            mediaAdapter: mediaAdapter(context.signal),
          },
        );
        return {
          answers,
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
          },
        };
      }),
    },
  );
}

const stageScript = `
const fs = require("node:fs");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tau-model-inline-"));
process.stdout.write(JSON.stringify(path.join(directory, "input")));
`;

const probeScript = `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tau-model-media-"));
try {
  const file = path.join(directory, "input");
  const fd = fs.openSync(input.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== input.size) throw new Error("media changed before validation");
    bytes = Buffer.alloc(input.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error("media changed before validation");
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("media changed before validation");
  } finally {
    fs.closeSync(fd);
  }
  if (require("node:crypto").createHash("sha256").update(bytes).digest("hex") !== input.sha256)
    throw new Error("media changed before validation");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  process.stdout.write(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-f", input.format, "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file], { timeout: 15000, maxBuffer: 1000000 }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
`;
