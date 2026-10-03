import { createReadStream } from "node:fs";
import { open, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { getElevenLabsApiKey } from "../config/schema.js";
import { mediaValidationConstraint, parseMediaJson } from "../utils/media_validation.js";
import type { RunToolCommandOptions } from "./cli.js";
import { ToolCliError } from "./errors.js";
import {
  describeMediaError,
  mediaRequest,
  parseMediaArgs,
  prepareMediaOutput,
  publishMediaArtifact,
  readMediaInput,
  readMediaJsonResponse,
  requiredArg,
} from "./media.js";

const SAMPLE_RATE = 24000;
const CHUNK_CHARACTERS = 2000;
const MAX_WAV_BYTES = 0xffffffff - 36;
const speechDocument = z.strictObject({
  voices: z.record(z.string().min(1), z.string().trim().min(1)),
  chunks: z
    .array(
      z
        .array(
          z.strictObject({
            speaker: z.string().min(1),
            text: z.string().refine((text) => text.trim().length > 0, "text must not be blank"),
          }),
        )
        .min(1),
    )
    .min(1),
});

type SpeechInput = { voice_id: string; text: string };
type SpeechBatch = { chunks: number[]; inputs: SpeechInput[]; characters: number };

function parseSpeechBatches(value: unknown): SpeechBatch[] {
  const result = speechDocument.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const [field, chunk, turn, ...rest] = issue.path;
      const location =
        field === "chunks" && typeof chunk === "number"
          ? `chunk ${chunk + 1}${typeof turn === "number" ? `, turn ${turn + 1}` : ""}${rest.length ? `, ${rest.join(".")}` : ""}`
          : issue.path.join(".") || "document";
      return `${location}: ${mediaValidationConstraint(issue)}`;
    });
    throw new ToolCliError(
      `invalid speech script: ${details.join("; ")}; correct --input before generating`,
    );
  }
  const document = result.data;
  const batches: SpeechBatch[] = [];
  const voices = new Set<string>();
  for (const [index, chunk] of document.chunks.entries()) {
    const characters = chunk.reduce((sum, turn) => sum + Array.from(turn.text).length, 0);
    if (characters > CHUNK_CHARACTERS) {
      throw new ToolCliError(
        `chunk ${index + 1} has ${characters} characters; maximum ${CHUNK_CHARACTERS}; split it into smaller chunks in --input`,
      );
    }
    const inputs = chunk.map((turn, turnIndex) => {
      const voice = Object.hasOwn(document.voices, turn.speaker)
        ? document.voices[turn.speaker]
        : undefined;
      if (!voice) {
        throw new ToolCliError(
          `chunk ${index + 1}, turn ${turnIndex + 1}: unknown speaker ${turn.speaker}; add it to voices or use a defined speaker`,
        );
      }
      voices.add(voice);
      return { voice_id: voice, text: turn.text };
    });
    const previous = batches.at(-1);
    if (previous && previous.characters + characters <= CHUNK_CHARACTERS) {
      previous.chunks.push(index + 1);
      previous.inputs.push(...inputs);
      previous.characters += characters;
    } else {
      batches.push({ chunks: [index + 1], inputs, characters });
    }
  }
  if (voices.size > 10) {
    throw new ToolCliError("speech supports at most 10 distinct voices");
  }
  return batches;
}

export function printSpeechGenerateHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage: tau tool speech-generate --model <eleven_v4_turbo|eleven_v4> --input <script.json> --output <audio.wav>",
      "       tau tool speech-generate --list-voices",
      "",
      'input: {"voices":{"narrator":"VOICE_ID"},"chunks":[[{"speaker":"narrator","text":"Hello."}]]}',
      "each chunk allows 2000 Unicode characters across its turns, including delivery tags.",
      "whole chunks may share a request; no automatic text splitting or rewriting.",
      "writes mono 24 kHz 16-bit PCM WAV and retains request batches in <output>.parts.",
      "requires ELEVENLABS_API_KEY or apiKeys.elevenlabs; never overwrites or retries.",
      "",
      "documentation: https://github.com/markusylisiurunen/tau/blob/main/docs/speech-generation.md",
    ].join("\n"),
  );
}

async function listVoices(fetchImpl: typeof fetch, apiKey: string, log: (line: string) => void) {
  const seenTokens = new Set<string>();
  let token: string | undefined;
  do {
    const url = new URL("https://api.elevenlabs.io/v2/voices");
    url.searchParams.set("page_size", "100");
    if (token) {
      url.searchParams.set("next_page_token", token);
    }
    const response = await mediaRequest(fetchImpl, url.href, { headers: { "xi-api-key": apiKey } });
    const page = await readMediaJsonResponse(
      response,
      8 * 1024 * 1024,
      z.object({
        voices: z.array(z.object({ voice_id: z.string(), name: z.string() })),
        has_more: z.boolean(),
        next_page_token: z.string().nullable().optional(),
      }),
      "ElevenLabs voice-list response",
    );
    for (const voice of page.voices) {
      log(JSON.stringify(voice));
    }
    if (!page.has_more) {
      return;
    }
    token = page.next_page_token ?? undefined;
    if (!token || seenTokens.has(token)) {
      throw new ToolCliError("provider returned invalid voice pagination");
    }
    seenTokens.add(token);
  } while (token);
}

async function savePcm(response: Response, path: string): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ToolCliError("provider returned no audio");
  }
  const file = await open(path, "wx", 0o600);
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.length;
      if (bytes > 128 * 1024 * 1024) {
        throw new ToolCliError("speech batch exceeds 128 MiB");
      }
      await file.writeFile(value);
    }
    if (!bytes || bytes % 2) {
      throw new ToolCliError("provider returned empty or unaligned PCM audio");
    }
  } finally {
    await file.close();
    await reader.cancel();
  }
  return bytes;
}

export async function assembleSpeechWav(paths: string[], output: string): Promise<void> {
  const sizes = await Promise.all(paths.map(async (path) => (await stat(path)).size));
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  if (!paths.length || sizes.some((size) => !size || size % 2) || bytes > MAX_WAV_BYTES) {
    throw new ToolCliError("PCM audio is empty, unaligned, or exceeds the WAV size limit");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(header);
    for (const [index, path] of paths.entries()) {
      let copied = 0;
      for await (const chunk of createReadStream(path)) {
        copied += chunk.length;
        if (copied > sizes[index]!) {
          throw new ToolCliError(`PCM file changed during assembly: ${path}`);
        }
        await file.writeFile(chunk);
      }
      if (copied !== sizes[index]) {
        throw new ToolCliError(`PCM file changed during assembly: ${path}`);
      }
    }
  } finally {
    await file.close();
  }
}

export async function runSpeechGenerateCommand(
  argv: string[],
  options: RunToolCommandOptions,
): Promise<void> {
  const args = parseMediaArgs(argv, {
    help: { type: "boolean", short: "h" },
    "list-voices": { type: "boolean" },
    model: { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
  });
  const log = options.stdout ?? console.log;
  if (args.help) {
    return printSpeechGenerateHelp(log);
  }
  if (args["list-voices"] && (args.model || args.input || args.output)) {
    throw new ToolCliError("--list-voices cannot be combined with generation options");
  }
  const apiKey = getElevenLabsApiKey(options.config, options.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (args["list-voices"]) {
    if (!apiKey) {
      throw new ToolCliError("missing ELEVENLABS_API_KEY or apiKeys.elevenlabs");
    }
    return listVoices(fetchImpl, apiKey, log);
  }
  const model = requiredArg(args.model, "model");
  if (model !== "eleven_v4_turbo" && model !== "eleven_v4") {
    throw new ToolCliError(`unsupported speech model: ${model}`);
  }
  const cwd = options.cwd ?? process.cwd();
  const input = requiredArg(args.input, "input");
  const output = requiredArg(args.output, "output");
  if (extname(output).toLowerCase() !== ".wav") {
    throw new ToolCliError("--output must have a .wav extension");
  }
  const batches = parseSpeechBatches(
    parseMediaJson(
      (await readMediaInput(resolve(cwd, input), "--input script")).toString("utf8"),
      `--input script ${input}`,
    ),
  );
  if (!apiKey) {
    throw new ToolCliError("missing ELEVENLABS_API_KEY or apiKeys.elevenlabs");
  }
  const destination = await prepareMediaOutput(output, cwd);
  const manifest = {
    model,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    output: destination.path,
    batches: batches.map((batch, index) => ({
      ...batch,
      file: `batch-${String(index + 1).padStart(4, "0")}.pcm`,
      completed: false,
      bytes: 0,
      requestId: null as string | null,
      characterCost: null as string | null,
    })),
  };
  const saveManifest = async () => {
    const temporary = join(destination.parts, "manifest.json.tmp");
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(temporary, join(destination.parts, "manifest.json"));
  };
  let stage = "saving the batch plan";
  let requestStarted = false;
  try {
    await saveManifest();
    for (const [index, batch] of manifest.batches.entries()) {
      stage = `preparing batch ${index + 1} of ${manifest.batches.length}`;
      const previousRequestIds = manifest.batches
        .slice(Math.max(0, index - 3), index)
        .map((previous) => {
          if (!previous.requestId) {
            throw new ToolCliError(
              "provider omitted request-id; cannot stitch the next speech batch",
            );
          }
          return previous.requestId;
        });
      stage = `requesting batch ${index + 1} of ${manifest.batches.length}`;
      requestStarted = true;
      const response = await mediaRequest(
        fetchImpl,
        "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=pcm_24000",
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: model,
            inputs: batch.inputs,
            ...(previousRequestIds.length ? { previous_request_ids: previousRequestIds } : {}),
          }),
        },
      );
      stage = `saving batch ${index + 1} of ${manifest.batches.length}`;
      batch.requestId = response.headers.get("request-id");
      batch.characterCost = response.headers.get("character-cost");
      await saveManifest();
      const path = join(destination.parts, batch.file);
      batch.bytes = await savePcm(response, `${path}.partial`);
      await rename(`${path}.partial`, path);
      batch.completed = true;
      await saveManifest();
    }
    stage = "assembling the WAV";
    const artifact = join(destination.parts, "assembled.wav");
    await assembleSpeechWav(
      manifest.batches.map((batch) => join(destination.parts, batch.file)),
      artifact,
    );
    stage = "publishing the WAV";
    await publishMediaArtifact(artifact, destination.path);
    log(
      JSON.stringify({
        output: destination.path,
        artifacts: destination.parts,
        batches: batches.length,
      }),
    );
  } catch (error) {
    throw new ToolCliError(
      `speech generation failed while ${stage}: ${describeMediaError(error)}; retained artifacts: ${destination.parts} (any saved manifest, completed .pcm batches, .partial downloads, and assembled.wav); inspect the manifest before recovery and do not reuse .partial files; ${requestStarted ? "no automatic retry; another generation request may incur another charge" : "no generation request was sent"}`,
    );
  }
}
