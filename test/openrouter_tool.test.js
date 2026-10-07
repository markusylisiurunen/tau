import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolCommand } from "../dist/core/tool/cli.js";
import { runOpenRouterCommand } from "../dist/core/tool/openrouter.js";

const roots = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-openrouter-test-"));
  roots.push(root);
  return root;
}
function chatReply(overrides = {}) {
  return {
    model: "openai/gpt-6-luna-20260922",
    id: "request-1",
    provider: "OpenAI",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "An answer", reasoning: "Not the answer" },
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
      cost: 0.0001,
      completion_tokens_details: { reasoning_tokens: 2 },
    },
    ...overrides,
  };
}
function harness(reply = chatReply()) {
  const stdout = vi.fn();
  const fetchImpl = vi.fn(async () => Response.json(reply));
  return { config: { apiKeys: { openrouter: "config-key" } }, env: {}, stdout, fetchImpl };
}
const chat = ["chat", "--model", "openai/gpt-6-luna", "--prompt", "Summarize"];
const decisions = ["decisions", "--model", "typesafe/jev-1.13", "--input", "-"];
const decisionInput = {
  state: { report: "Checkout broke" },
  questions: {
    bug: { type: "noul", instructions: "Is it a bug?" },
    team: {
      type: "choice",
      instructions: { task: "Route" },
      criteria: { payments: "Payments", other: null },
    },
    urgency: { type: "score", instructions: "Urgency", criteria: ["Low", "High"] },
  },
};
function decisionReply() {
  return {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      bug: { type: "noul", noul: 0.1 },
      team: {
        type: "choice",
        choice: "payments",
        probabilities: { payments: 0.6, other: 0.4 },
        confidence: 0.5,
      },
      urgency: { type: "score", score: 0.6, legend: { 0: "Low", 1: "High" } },
    },
    usage: { input_tokens: 20, output_tokens: 10, cost: 0.0002 },
  };
}
function stdin(value = decisionInput) {
  return Readable.from([JSON.stringify(value)]);
}

function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  return bytes;
}

describe("OpenRouter standalone commands", () => {
  it.each(["chat", "decisions"])(
    "flushes a large %s result through piped stdout before successful exit",
    async (operation) => {
      const root = await fixture();
      const text = "A long answer. ".repeat(100_000);
      const reply = operation === "chat" ? chatReply() : decisionReply();
      if (operation === "chat") reply.choices[0].message.content = text;
      else reply.answers.urgency.legend[1] = text;
      const responsePath = join(root, "response.json");
      const inputPath = join(root, "input.json");
      await writeFile(responsePath, JSON.stringify(reply));
      await writeFile(inputPath, JSON.stringify(decisionInput));
      const args = operation === "chat" ? chat : [...decisions.slice(0, -1), inputPath];
      const cliUrl = new URL("../dist/core/tool/cli.js", import.meta.url).href;
      const script = `
        import { readFile } from "node:fs/promises";
        import { runToolCommand } from ${JSON.stringify(cliUrl)};
        const response = await readFile(${JSON.stringify(responsePath)}, "utf8");
        await runToolCommand(${JSON.stringify(["openrouter", ...args])}, {
          config: { apiKeys: { openrouter: "test-key" } },
          env: {},
          fetchImpl: async () => new Response(response),
        });
        process.exit(0);
      `;
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { maxBuffer: 8_000_000, timeout: 30_000 },
      );
      expect(stderr).toBe("");
      const result = JSON.parse(stdout);
      expect(result.requested_model).toBe(args[2]);
      expect(operation === "chat" ? result.answer : result.answers.urgency.legend[1]).toBe(text);
    },
  );

  it("dispatches offline help and fixed catalogs without touching stdin, credentials, or network", async () => {
    for (const operation of ["decisions", "chat"]) {
      const options = {
        ...harness(),
        config: {},
        stdin: new Readable({
          read() {
            throw new Error("must not read");
          },
        }),
      };
      await runOpenRouterCommand(
        [operation, "--help", "--input", "-"].filter(
          (arg) => operation === "decisions" || !["--input", "-"].includes(arg),
        ),
        options,
      );
      await runToolCommand(["openrouter", operation, "--list-models"], options);
      expect(options.fetchImpl).not.toHaveBeenCalled();
      const catalog = JSON.parse(options.stdout.mock.calls.at(-1)[0]);
      expect(catalog.models.map((model) => model.id)).toEqual(
        operation === "decisions"
          ? ["openai/gpt-6-luna-decisions", "typesafe/jev-1.13"]
          : [
              "google/gemini-3.8-flash",
              "openai/gpt-6-luna",
              "openai/gpt-6.1-sol",
              "anthropic/claude-opus-5.5",
            ],
      );
      expect(catalog.models.every((model) => model.inputs.length && model.role)).toBe(true);
    }
  });

  it("sends only explicit chat context, omits token caps/default reasoning, and preserves reported metadata", async () => {
    const options = harness();
    await runToolCommand(["openrouter", ...chat], options);
    const [url, init] = options.fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.Authorization).toBe("Bearer config-key");
    expect(JSON.parse(init.body)).toEqual({
      model: "openai/gpt-6-luna",
      stream: false,
      provider: { require_parameters: true },
      messages: [{ role: "user", content: [{ type: "text", text: "Summarize" }] }],
    });
    expect(JSON.parse(options.stdout.mock.calls[0][0])).toEqual({
      requested_model: "openai/gpt-6-luna",
      model: "openai/gpt-6-luna-20260922",
      id: "request-1",
      provider: "OpenAI",
      answer: "An answer",
      finish_reason: "stop",
      usage: chatReply().usage,
    });
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads prompt and system files relative to cwd and prefers the ambient credential", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "prompt"), "Question\n");
    await writeFile(join(cwd, "system"), "Be concise\n");
    const options = { ...harness(), cwd, env: { OPENROUTER_API_KEY: " env-key " } };
    await runOpenRouterCommand(
      [
        "chat",
        "--model",
        "openai/gpt-6-luna",
        "--prompt-file",
        "prompt",
        "--system-file",
        "system",
        "--reasoning",
        "none",
      ],
      options,
    );
    const init = options.fetchImpl.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer env-key");
    expect(JSON.parse(init.body)).toMatchObject({
      reasoning: { effort: "none" },
      messages: [
        { role: "system", content: "Be concise\n" },
        { role: "user", content: [{ type: "text", text: "Question\n" }] },
      ],
    });
  });

  it("preserves mixed media order and bytes, validates private snapshots, and cleans them up", async () => {
    const cwd = await fixture();
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const audio = wav();
    const video = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
    await writeFile(join(cwd, "image"), image);
    await writeFile(join(cwd, "audio"), audio);
    await writeFile(join(cwd, "video"), video);
    const snapshots = [];
    const spawnImpl = vi.fn(async (command, args, limits) => {
      expect(command).toBe("ffprobe");
      expect(args).toContain("-protocol_whitelist");
      expect(limits).toMatchObject({
        timeoutMs: 15000,
        maxCaptureBytes: 1000000,
        killProcessGroup: true,
      });
      snapshots.push(args.at(-1));
      const isVideo = args.includes("mov");
      expect(await readFile(args.at(-1))).toEqual(isVideo ? video : audio);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: "2" },
          streams: isVideo
            ? [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }]
            : [{ codec_type: "audio", codec_name: "pcm_s16le" }],
        }),
      };
    });
    const options = { ...harness(), cwd, spawnImpl };
    await runOpenRouterCommand(
      [
        "chat",
        "--model",
        "google/gemini-3.8-flash",
        "--prompt",
        "Compare",
        "--video",
        "video",
        "--image",
        "image",
        "--audio",
        "audio",
        "--system",
        "Be precise",
        "--reasoning",
        "high",
      ],
      options,
    );
    const body = JSON.parse(options.fetchImpl.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "system", content: "Be precise" },
      {
        role: "user",
        content: [
          { type: "text", text: "Compare" },
          {
            type: "video_url",
            video_url: { url: `data:video/mp4;base64,${video.toString("base64")}` },
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
          },
          { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "wav" } },
        ],
      },
    ]);
    for (const path of snapshots)
      await expect(readdir(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [...chat, "--prompt-file", "missing"],
    [...chat, "--system", "a", "--system-file", "missing"],
    [...chat, "--system", "  "],
    [...chat, "--audio", "missing"],
    [...chat, "--video", "missing"],
    [...chat, "--reasoning", "minimal"],
    [...chat, "--model", "openai/gpt-6.1-sol"],
    [...chat, "--max-tokens", "100"],
    [...chat, "--list-models"],
    ["chat", "--model", "arbitrary/model", "--prompt", "x"],
    ["chat", "--model", "openai/gpt-6.1-sol", "--prompt", "x", "--reasoning", "none"],
  ])("rejects invalid flags before IO or billing: %j", async (...args) => {
    const options = harness();
    await expect(runOpenRouterCommand(args, options)).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(options.stdout).not.toHaveBeenCalled();
  });

  it("preserves arbitrary JSON context keys and rejects reserved question names instead of silently dropping them", async () => {
    const state = JSON.parse('{"__proto__":{"example":true},"nested":[{"__proto__":"text"}]}');
    const options = { ...harness(decisionReply()), stdin: stdin({ ...decisionInput, state }) };
    await runOpenRouterCommand(decisions, options);
    expect(JSON.parse(JSON.parse(options.fetchImpl.mock.calls[0][1].body).state)).toEqual(state);
    const invalid = {
      ...harness(),
      stdin: stdin({
        ...decisionInput,
        questions: JSON.parse(
          '{"__proto__":{"type":"noul","instructions":"x"},"valid":{"type":"noul","instructions":"y"}}',
        ),
      }),
    };
    await expect(runOpenRouterCommand(decisions, invalid)).rejects.toThrow();
    expect(invalid.fetchImpl).not.toHaveBeenCalled();
  });

  it("round-trips typed decisions from file and chunked stdin without inventing metadata or thresholds", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "input.json"), JSON.stringify(decisionInput));
    for (const path of ["-", "input.json"]) {
      const text = JSON.stringify(decisionInput);
      const options = {
        ...harness(decisionReply()),
        cwd,
        stdin: Readable.from([text.slice(0, 15), text.slice(15)]),
      };
      await runOpenRouterCommand([...decisions.slice(0, -1), path], options);
      const [url, init] = options.fetchImpl.mock.calls[0];
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(JSON.parse(init.body)).toEqual({
        model: "typesafe/jev-1.13",
        state: JSON.stringify(decisionInput.state),
        questions: decisionInput.questions,
      });
      expect(JSON.parse(options.stdout.mock.calls[0][0])).toEqual({
        requested_model: "typesafe/jev-1.13",
        ...decisionReply(),
      });
    }
  });

  it("round-trips Luna Decisions with all question types and input-only usage", async () => {
    const reply = {
      ...decisionReply(),
      model: "openai/gpt-6-luna-decisions-20261006",
      provider: "OpenAI",
      usage: { input_tokens: 382, output_tokens: 0, cost: 0.0000382 },
    };
    const options = { ...harness(reply), stdin: stdin() };
    await runOpenRouterCommand(
      ["decisions", "--model", "openai/gpt-6-luna-decisions", "--input", "-"],
      options,
    );
    expect(JSON.parse(options.fetchImpl.mock.calls[0][1].body)).toEqual({
      model: "openai/gpt-6-luna-decisions",
      state: JSON.stringify(decisionInput.state),
      questions: decisionInput.questions,
    });
    expect(JSON.parse(options.stdout.mock.calls[0][0])).toEqual({
      requested_model: "openai/gpt-6-luna-decisions",
      ...reply,
    });
  });

  it.each(["openai/gpt-6-luna-decisions", "typesafe/jev-1.13"])(
    "keeps image-part-shaped %s state as text rather than bypassing attachment validation",
    async (model) => {
      const state = [
        { type: "text", text: "An example of a request" },
        { type: "image_url", image_url: { url: "https://example.com/unvalidated.png" } },
      ];
      const options = {
        ...harness({ ...decisionReply(), model }),
        stdin: stdin({ ...decisionInput, state }),
      };
      await runOpenRouterCommand(["decisions", "--model", model, "--input", "-"], options);
      expect(JSON.parse(options.fetchImpl.mock.calls[0][1].body).state).toBe(JSON.stringify(state));
      expect(options.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("preserves ordered decision image bytes and serializes structured state as text", async () => {
    const cwd = await fixture();
    const images = await Promise.all(
      ["red", "blue"].map((background) =>
        sharp({ create: { width: 64, height: 64, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    await writeFile(join(cwd, "first.png"), images[0]);
    await writeFile(join(cwd, "second.png"), images[1]);
    const options = {
      ...harness({ ...decisionReply(), model: "openai/gpt-6-luna-decisions" }),
      cwd,
      stdin: stdin(),
    };
    await runOpenRouterCommand(
      [
        "decisions",
        "--model",
        "openai/gpt-6-luna-decisions",
        "--input",
        "-",
        "--image",
        "first.png",
        "--image",
        "second.png",
      ],
      options,
    );
    const [url, init] = options.fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(JSON.parse(init.body)).toEqual({
      model: "openai/gpt-6-luna-decisions",
      state: [
        { type: "text", text: JSON.stringify(decisionInput.state) },
        ...images.map((bytes) => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
        })),
      ],
      questions: decisionInput.questions,
    });
    expect(JSON.parse(options.stdout.mock.calls[0][0]).answers).toEqual(decisionReply().answers);
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["typesafe/jev-1.13", "--image", "missing.png"],
    ["openai/gpt-6-luna-decisions", "--audio", "missing.wav"],
    ["openai/gpt-6-luna-decisions", "--video", "missing.mp4"],
    ["openai/gpt-6-luna-decisions", "--image", "broken.png"],
  ])(
    "rejects unsupported or invalid decision attachments before billing: %s %s",
    async (model, flag, path) => {
      const cwd = await fixture();
      await writeFile(join(cwd, "broken.png"), "not an image");
      const options = { ...harness(), cwd, stdin: stdin() };
      await expect(
        runOpenRouterCommand(["decisions", "--model", model, "--input", "-", flag, path], options),
      ).rejects.toThrow();
      expect(options.fetchImpl).not.toHaveBeenCalled();
      expect(options.stdout).not.toHaveBeenCalled();
    },
  );

  it.each([
    Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`q${i}`, decisionInput.questions.bug]),
    ),
    {
      q: {
        type: "choice",
        instructions: "Choose",
        criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`c${i}`, null])),
      },
    },
    { q: { type: "score", instructions: "Rate", criteria: ["Only"] } },
    {
      q: {
        type: "score",
        instructions: "Rate",
        criteria: Array.from({ length: 11 }, (_, i) => `Level ${i}`),
      },
    },
  ])("rejects Luna-specific question limits before billing", async (questions) => {
    const options = { ...harness(), stdin: stdin({ state: "report", questions }) };
    await expect(
      runOpenRouterCommand(
        ["decisions", "--model", "openai/gpt-6-luna-decisions", "--input", "-"],
        options,
      ),
    ).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts Luna's maximum question, choice, and score counts", async () => {
    const questions = Object.fromEntries(
      Array.from({ length: 198 }, (_, i) => [`q${i}`, decisionInput.questions.bug]),
    );
    questions.team = {
      type: "choice",
      instructions: "Choose",
      criteria: Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`c${i}`, null])),
    };
    questions.urgency = {
      type: "score",
      instructions: "Rate",
      criteria: Array.from({ length: 10 }, (_, i) => `Level ${i}`),
    };
    const answers = Object.fromEntries(
      Array.from({ length: 198 }, (_, i) => [`q${i}`, { type: "noul", noul: 0.5 }]),
    );
    answers.team = { type: "choice", choice: "c254" };
    answers.urgency = { type: "score", score: 9 };
    const options = {
      ...harness({
        model: "openai/gpt-6-luna-decisions",
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
      stdin: stdin({ state: "report", questions }),
    };
    await runOpenRouterCommand(
      ["decisions", "--model", "openai/gpt-6-luna-decisions", "--input", "-"],
      options,
    );
    expect(JSON.parse(options.stdout.mock.calls[0][0]).answers).toEqual(answers);
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not publish refused Luna answers as judgments", async () => {
    const reply = { ...decisionReply(), model: "openai/gpt-6-luna-decisions" };
    reply.answers.bug = { type: "refusal" };
    const options = { ...harness(reply), stdin: stdin() };
    await expect(
      runOpenRouterCommand(
        ["decisions", "--model", "openai/gpt-6-luna-decisions", "--input", "-"],
        options,
      ),
    ).rejects.toThrow();
    expect(options.stdout).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves Jev's single-level score rubric", async () => {
    const options = {
      ...harness({
        model: "typesafe/jev-1.13",
        answers: { q: { type: "score", score: 0 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      stdin: stdin({
        state: "report",
        questions: { q: { type: "score", instructions: "Rate", criteria: ["Only"] } },
      }),
    };
    await runOpenRouterCommand(decisions, options);
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { ...decisionInput, model: "typesafe/jev-1.13" },
    { ...decisionInput, provider: {} },
    { state: "x", questions: {} },
    { state: true, questions: decisionInput.questions },
    { state: "x", questions: { bad: { type: "choice", instructions: "x", criteria: {} } } },
    { state: "x", questions: { bad: { type: "score", instructions: "x", criteria: [] } } },
    {
      state: "x",
      questions: { bad: { type: "noul", instructions: "x", criteria: { true: "yes" } } },
    },
  ])("rejects invalid decision documents before billing", async (input) => {
    const options = { ...harness(), stdin: stdin(input) };
    await expect(runOpenRouterCommand(decisions, options)).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds stdin, rejects interactive/invalid UTF-8/empty/multiple JSON documents, and times out unfinished input", async () => {
    for (const bytes of [
      Buffer.from(""),
      Buffer.from("{}{}"),
      Buffer.from([0xff]),
      Buffer.alloc(1_000_001),
    ]) {
      const options = { ...harness(), stdin: Readable.from([bytes]) };
      await expect(runOpenRouterCommand(decisions, options)).rejects.toThrow();
      expect(options.fetchImpl).not.toHaveBeenCalled();
    }
    const options = { ...harness(), stdin: Object.assign(stdin(), { isTTY: true }) };
    await expect(runOpenRouterCommand(decisions, options)).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const stalled = new Readable({ read() {} });
    const running = runOpenRouterCommand(decisions, { ...options, stdin: stalled });
    const rejected = expect(running).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(stalled.destroyed).toBe(true);
  });

  it.each([
    (reply) => {
      delete reply.answers.bug;
    },
    (reply) => {
      reply.answers.extra = { type: "noul", noul: 0.5 };
    },
    (reply) => {
      reply.answers.bug.noul = 1.1;
    },
    (reply) => {
      reply.answers.bug = { type: "score", score: 0.5 };
    },
    (reply) => {
      reply.answers.team.choice = "unknown";
    },
    (reply) => {
      reply.answers.team.probabilities.unknown = 0.1;
    },
    (reply) => {
      reply.answers.urgency.score = 2;
    },
    (reply) => {
      reply.answers.urgency.legend[2] = "Unknown";
    },
  ])("rejects missing, mismatched, or out-of-range decision answers", async (mutate) => {
    const reply = decisionReply();
    mutate(reply);
    const options = { ...harness(reply), stdin: stdin() };
    await expect(runOpenRouterCommand(decisions, options)).rejects.toThrow();
    expect(options.stdout).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { finish_reason: "length", content: "Partial", refusal: undefined },
    { finish_reason: "content_filter", content: null, refusal: "Refused" },
    { finish_reason: "stop", content: null, refusal: "Refused" },
  ])(
    "keeps truncation and refusal distinct from complete answers",
    async ({ finish_reason, content, refusal }) => {
      const options = harness(
        chatReply({
          choices: [
            {
              finish_reason,
              native_finish_reason: "native",
              message: { role: "assistant", content, refusal, reasoning: "Never the answer" },
            },
          ],
          usage: undefined,
        }),
      );
      await runOpenRouterCommand(chat, options);
      expect(JSON.parse(options.stdout.mock.calls[0][0])).toEqual({
        requested_model: "openai/gpt-6-luna",
        model: "openai/gpt-6-luna-20260922",
        id: "request-1",
        provider: "OpenAI",
        answer: content,
        finish_reason,
        native_finish_reason: "native",
        ...(refusal === undefined ? {} : { refusal }),
      });
    },
  );

  it.each([401, 402, 403, 429, 502])(
    "reports HTTP %i without leaking response data or retrying",
    async (status) => {
      const options = harness();
      options.fetchImpl.mockImplementation(
        async () => new Response("secret provider diagnostic", { status }),
      );
      await expect(runOpenRouterCommand(chat, options)).rejects.toThrow(String(status));
      expect(options.fetchImpl).toHaveBeenCalledTimes(1);
      expect(options.stdout).not.toHaveBeenCalled();
    },
  );

  it("rejects provider errors in successful HTTP responses, invalid JSON, oversized bodies, and network failures without retrying", async () => {
    for (const reply of [
      () => Response.json({ error: { code: 502, message: "secret diagnostic" } }),
      () => new Response("not JSON"),
      () => new Response("x".repeat(8_000_001)),
      () =>
        Response.json(
          chatReply({
            choices: [
              { finish_reason: "error", message: { role: "assistant", content: "Partial" } },
            ],
          }),
        ),
      () =>
        Response.json(
          chatReply({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: null, reasoning: "No answer" },
              },
            ],
          }),
        ),
      () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    ]) {
      const options = harness();
      options.fetchImpl.mockImplementation(async () => reply());
      await expect(runOpenRouterCommand(chat, options)).rejects.toThrow();
      expect(options.fetchImpl).toHaveBeenCalledTimes(1);
      expect(options.stdout).not.toHaveBeenCalled();
    }
  });

  it("normalizes API text parts and content-less refusals without exposing reasoning", async () => {
    for (const [message, answer] of [
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "First " },
            { type: "text", text: "second" },
          ],
          reasoning: "Hidden",
        },
        "First second",
      ],
      [{ role: "assistant", refusal: "Refused", reasoning: "Hidden" }, null],
    ]) {
      const options = harness(chatReply({ choices: [{ finish_reason: "stop", message }] }));
      await runOpenRouterCommand(chat, options);
      const output = JSON.parse(options.stdout.mock.calls[0][0]);
      expect(output.answer).toBe(answer);
      expect(output).not.toHaveProperty("reasoning");
    }
  });

  it("rejects missing and malformed credentials without exposing them or sending", async () => {
    for (const key of [undefined, "secret\nkey", "secret\u0100key"]) {
      const options = {
        ...harness(),
        config: {},
        env: key === undefined ? {} : { OPENROUTER_API_KEY: key },
      };
      const error = await runOpenRouterCommand(chat, options).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain("secret");
      expect(options.fetchImpl).not.toHaveBeenCalled();
      expect(options.stdout).not.toHaveBeenCalled();
    }
  });

  it.each(["chat", "decisions"])(
    "bounds the complete encoded %s request including media overhead before sending",
    async (operation) => {
      const cwd = await fixture();
      const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
        .png()
        .toBuffer();
      const padded = Buffer.alloc(4_999_998);
      image.copy(padded);
      await writeFile(join(cwd, "image"), padded);
      const options = { ...harness(), cwd, stdin: stdin() };
      const args =
        operation === "chat"
          ? chat
          : ["decisions", "--model", "openai/gpt-6-luna-decisions", "--input", "-"];
      await expect(
        runOpenRouterCommand(
          [...args, "--image", "image", "--image", "image", "--image", "image"],
          options,
        ),
      ).rejects.toThrow();
      expect(options.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects corrupt, oversized, over-count, and over-duration media before sending and cleans failed probes", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "bad"), "not an image");
    await writeFile(join(cwd, "large"), Buffer.alloc(5_000_001));
    await writeFile(join(cwd, "audio"), wav());
    let snapshot;
    const spawnImpl = vi.fn(async (_command, args) => {
      snapshot = args.at(-1);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: "601" },
          streams: [{ codec_type: "audio", codec_name: "pcm_s16le" }],
        }),
      };
    });
    for (const flags of [
      ["--image", "bad"],
      ["--image", "large"],
      Array.from({ length: 17 }, () => ["--image", "missing"]).flat(),
      ["--audio", "audio"],
    ]) {
      const options = { ...harness(), cwd, spawnImpl };
      await expect(
        runOpenRouterCommand(
          ["chat", "--model", "google/gemini-3.8-flash", "--prompt", "x", ...flags],
          options,
        ),
      ).rejects.toThrow();
      expect(options.fetchImpl).not.toHaveBeenCalled();
    }
    await expect(readdir(dirname(snapshot))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
