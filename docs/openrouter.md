# OpenRouter

`tau tool openrouter` provides standalone, single-request utilities for typed decisions and text or media understanding. They work from a shell inside or outside Tau, without a session, persona, conversation, tools, or session accounting. Only explicitly supplied content is sent to OpenRouter and its selected provider. Judgments are advisory model output, not a security or permission boundary.

## Credentials and requirements

Install Tau and configure `OPENROUTER_API_KEY`, or put `apiKeys.openrouter` in the global `~/.config/tau/config.json` on the machine running the command. A nonblank environment key takes precedence. Project configuration cannot supply API keys. There is no key flag.

Tau's local Bash removes inherited credential-shaped environment variables. When invoking through Bash, configure the key on that machine through global configuration or its own supported environment setup. See [credentials](credentials.md) and [tools](tools.md).

Audio and video require `ffprobe` from FFmpeg on `PATH`: `brew install ffmpeg` on macOS or `apt install ffmpeg` on Debian/Ubuntu. Text and images do not require FFmpeg. Media is validated locally, not transcoded.

```sh
tau tool openrouter --help
tau tool openrouter decisions --help
tau tool openrouter chat --help
tau tool openrouter decisions --list-models
tau tool openrouter chat --list-models
```

Help and model listing require neither credentials nor network access and never read stdin. `--list-models` is a separate mode, incompatible with request flags, and prints one JSON object containing `models`, with each model's `id`, `inputs`, `reasoning` settings, and `role` guidance. `--help` and `-h` print text help.

## Fixed model choices

An actual request requires an exact `--model` ID from this table. There is no default, arbitrary-ID escape hatch, live discovery, refresh, or automatic model substitution. A versioned ID is not necessarily an immutable provider snapshot; output records the returned model separately.

| Operation | Model | Inputs and suggested role | Reasoning efforts |
| --- | --- | --- | --- |
| `decisions` | `typesafe/jev-1.13` | Structured state and questions; classification, scoring, verification with probabilities | Not supported |
| `chat` | `google/gemini-3.8-flash` | Text, images, audio, video; first choice for audio/video and image-heavy analysis | `low`, `medium`, `high` |
| `chat` | `openai/gpt-6-luna` | Text and images; cheap everyday extraction, summarization, and routine questions | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `chat` | `openai/gpt-6.1-sol` | Text and images; coding, debugging, technical reasoning | `low`, `medium`, `high`, `xhigh`, `max` |
| `chat` | `anthropic/claude-opus-5.5` | Text and images; premium generalist for writing, synthesis, difficult reasoning, and second opinions | `low`, `medium`, `high`, `xhigh`, `max` |

Roles are selection guidance, not benchmark guarantees or restrictions on tasks. Unsupported settings and modalities fail locally rather than switching models, transcribing audio, or extracting video frames.

## Input and examples

### Decisions

```sh
tau tool openrouter decisions --model typesafe/jev-1.13 --input ./decision.json
```

`--input` is required. A file path reads a UTF-8 JSON document. Exactly `--input -` reads one complete document from stdin until EOF:

```sh
tau tool openrouter decisions --model typesafe/jev-1.13 --input - <<'JSON'
{
  "state": { "ticket": "The checkout page crashes when I click Pay." },
  "questions": {
    "is_bug": {
      "type": "noul",
      "instructions": "Does this report describe broken product behavior?"
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": {
        "payments": "Checkout or billing problems",
        "other": "Problems unrelated to payments"
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is the issue?",
      "criteria": ["Can wait", "Fix soon", "Blocking revenue"]
    }
  }
}
JSON
```

Pipelines and heredocs work inside Tau's noninteractive Bash. Stdin must not be a terminal and must reach EOF within 30 seconds. Empty input, malformed JSON, multiple documents, invalid UTF-8, and oversized input fail before any request.

The input contains exactly `state` and `questions`. The model belongs only in `--model`, not the document. `state` is a string, JSON object, or array. `questions` is a nonempty map of nonempty names to questions:

- `noul`: required `instructions`; optional `criteria` with both `true` and `false`. The answer's `noul` is a probability from zero to one, not a boolean.
- `choice`: required `instructions` and a nonempty `criteria` object mapping category names to guidance. The answer's `choice` names a supplied category; optional `probabilities` and `confidence` retain provider probabilities.
- `score`: required `instructions` and a nonempty ordered `criteria` array. The answer's `score` is a numeric position from zero to the last rubric index, possibly fractional. Optional `legend`, `probabilities`, and `confidence` retain distribution details.

Instructions and criterion guidance accept strings, JSON objects, or arrays; choice criterion values may also be `null`. Unknown question fields and the reserved question/category name `__proto__` are rejected. Arbitrary keys within state and guidance are preserved. Several independent questions can share one state; dependent questions require separate calls.

The command posts once to OpenRouter's alpha Decisions endpoint. It validates answer names, types, categories, rubric ranges, and probability bounds. Successful output is one JSON object:

```json
{
  "requested_model": "typesafe/jev-1.13",
  "model": "typesafe/jev-1.13-20260917",
  "answers": { "is_bug": { "type": "noul", "noul": 0.96 } },
  "usage": { "input_tokens": 100, "output_tokens": 10, "cost": 0.00001 }
}
```

This illustrates a single-question response; every submitted question must have an answer. Provider `id` and `provider` are included when supplied. Usage contains reported token counts and optional reported cost, never an estimated cost. Negative judgments and low confidence still exit successfully. No thresholds or prose explanations are invented.

### Chat

```sh
tau tool openrouter chat \
  --model openai/gpt-6.1-sol \
  --system 'Review carefully. Separate observations from assumptions.' \
  --prompt-file ./review-context.txt \
  --image ./error.png \
  --reasoning high
```

Flags belong after `chat`. No positional arguments are accepted.

| Flag | Contract |
| --- | --- |
| `--model <id>` | Required exact shipped chat model ID |
| `--prompt <text>` or `--prompt-file <path>` | Exactly one required; nonblank UTF-8 user prompt |
| `--system <text>` or `--system-file <path>` | Optional, mutually exclusive, nonblank explicit system instructions |
| `--image <path>` | Repeatable local PNG, JPEG, or WebP image |
| `--audio <path>` | Repeatable local WAV or MP3 audio; Gemini only |
| `--video <path>` | Local MP4 video; Gemini only |
| `--reasoning <effort>` | Optional model-supported effort from the table |

All file paths resolve relative to the invoking working directory. Prompt/system files name regular files; `-` has special stdin meaning only for decisions. Omitting system instructions sends no system message. Omitting reasoning leaves that parameter to the provider, not necessarily disabled. Effort does not request a written reasoning trace.

Media flags may be mixed; the request contains the prompt first, followed by attachments in command-line order. Files are embedded inline as data URLs or base64 audio, not uploaded to public hosting. There are no remote URL inputs, generated media, automatic resizing, clipping, conversion, chunking, conversation history, or tool execution.

```sh
tau tool openrouter chat \
  --model google/gemini-3.8-flash \
  --prompt 'Compare this recording with the reference and spoken requirements.' \
  --video ./recording.mp4 \
  --image ./reference.png \
  --audio ./requirements.wav > ./analysis.json
```

Chat sends one non-streaming completion request. It imposes no output token cap: neither `max_tokens` nor `max_completion_tokens` is sent, and there is no `--max-tokens` flag. Provider defaults, remaining context, and model limits still apply; omission does not mean unlimited output.

Successful stdout contains one JSON object with `requested_model`, returned `model`, `answer` (text or `null`), and `finish_reason`. Reported `id`, `provider`, `usage` (including cost and token details), `native_finish_reason`, and `refusal` appear when supplied. Missing optional metadata is not fabricated. Reasoning is never substituted for the answer or returned as answer text.

- `stop` with no refusal is a complete answer.
- `length` is truncated output, even if answer text is empty.
- `content_filter` or a nonempty `refusal` indicates refusal, not a complete answer.

These are successful exchanges with distinguishable outcomes; scripts must inspect them. Provider errors, malformed responses, unexpected tool calls, and a normal stop with neither answer nor refusal fail instead of masquerading as an answer.

## Outputs and recovery

These are conservative utility safety limits, not promises of every provider's maximum capacity. All byte limits use decimal bytes.

| Resource | Limit |
| --- | --- |
| Decisions JSON, each prompt or system input | 1,000,000 UTF-8 bytes |
| Attachments per request | 16 total, including at most 4 audio files and 1 video |
| Each image | 5,000,000 bytes, 8,000 pixels per edge, 32 megapixels; one frame |
| Each audio or video | 12,000,000 bytes |
| Audio formats | Single-stream PCM 16-bit little-endian WAV or MP3 |
| Video format | H.264 MP4 up to 3840×2160 with optional AAC audio |
| Audio/video duration | Known positive duration; 600 seconds combined |
| Complete encoded JSON request | 20,000,000 bytes, including base64 expansion and text |
| Response | 8,000,000 bytes |
| Local media probe | 15 seconds per file |
| HTTP request and response | 10 minutes |

Oversized or unsupported inputs fail before sending. Audio/video validation uses private temporary copies of the exact bytes being submitted and removes those copies after probing. Keep FFmpeg current when handling untrusted media.

Diagnostics go to stderr and failures exit nonzero. Authentication, insufficient credits, permission failures, rate limits, and provider/service failures report distinct status diagnostics without dumping provider bodies. There are no automatic retries, including after timeouts or interrupted connections: the provider may already have charged for an unknown outcome. A response exceeding the safety bound can fail after a billable request.

No paid inference compatibility guarantee follows from local validation. OpenRouter's alpha Decisions contract and provider availability can change independently of Tau. Review the actual output and current service errors rather than treating model judgments as verified facts.
