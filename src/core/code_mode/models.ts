import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApiKeysConfig } from "../config/index.js";
import {
  openRouterModels,
  requestOpenRouterChat,
  requestOpenRouterDecisions,
} from "../models/openrouter.js";
import type { OpenRouterAttachment, OpenRouterMediaAdapter } from "../models/openrouter_media.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { CodeModeCapability } from "./capability.js";

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

async function infer<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (!(error instanceof Error) || !/openrouter/i.test(error.message)) throw error;
    const message = error.message.includes("OPENROUTER_API_KEY")
      ? "Model inference is not configured"
      : error.message.replace(/OpenRouter/gi, "model service");
    throw new Error(message);
  }
}

export function createModelsCapability(
  backend: ToolExecutionBackend,
  config: ApiKeysConfig,
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

  return {
    name: "models",
    description:
      "Run standalone model calls for text and media analysis, structured output, and typed decisions.",
    api: {
      list: (args) => {
        z.tuple([]).parse(args);
        return Object.fromEntries(
          Object.entries(openRouterModels).map(([operation, models]) => [
            operation,
            models.map(({ id, inputs, reasoning, role }) => ({ id, inputs, reasoning, role })),
          ]),
        );
      },
      chat: async (args, context) => {
        const [input, options] = z.tuple([chatInput, chatOptions]).parse(args);
        const turns =
          typeof input === "string" ? [{ role: "user" as const, content: input }] : input;
        const result = await infer(
          requestOpenRouterChat(
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
          ),
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
                  prompt_tokens: usage.prompt_tokens,
                  completion_tokens: usage.completion_tokens,
                  total_tokens: usage.total_tokens,
                  ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
                },
              }
            : {}),
        };
      },
      decisions: async (args, context) => {
        const [state, options] = z.tuple([z.json(), decisionOptions]).parse(args);
        const { answers, usage } = await infer(
          requestOpenRouterDecisions(
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
          ),
        );
        return {
          answers,
          ...(usage
            ? {
                usage: {
                  input_tokens: usage.input_tokens,
                  output_tokens: usage.output_tokens,
                  ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
                },
              }
            : {}),
        };
      },
    },
  };
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
