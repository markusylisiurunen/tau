# OpenRouter

`tau tool openrouter` makes single model requests for typed decisions and for analyzing text or media. It has no session or conversation, and only what you pass is sent. Its output is model judgment, so never use it as a security or permission check.

## Credentials and requirements

Needs `OPENROUTER_API_KEY` or `apiKeys.openrouter` in global configuration. When the agent runs the command, use global configuration, because Bash commands do not inherit keys. Audio and video also need `ffprobe` from FFmpeg.

```sh
tau tool openrouter decisions --help
tau tool openrouter chat --list-models
```

`--model` is required and must be one of these exact IDs:

| Operation | Model | Use for |
| --- | --- | --- |
| `decisions` | `openai/gpt-6-luna-decisions` | First choice, supports text and images |
| `decisions` | `google/gemini-decision-1` | Judgments about audio or video |
| `decisions` | `typesafe/jev-1.14` | High volume when cost matters most |
| `chat` | `google/gemini-3.8-flash` | First choice for audio, video, and images |
| `chat` | `google/gemini-4-carbon` | Multimodal analysis |
| `chat` | `openai/gpt-6-luna` | Cheap extraction and summaries |
| `chat` | `openai/gpt-6.1-terra` | Visual reasoning, writing, everyday coding |
| `chat` | `openai/gpt-6.1-sol` | Coding and technical reasoning |
| `chat` | `anthropic/claude-sonnet-5.5` | Writing, coding, general reasoning |
| `chat` | `anthropic/claude-opus-5.5` | Difficult reasoning and second opinions |

## Input and examples

### Decisions

A decision asks independent typed questions about some `state`:

```sh
tau tool openrouter decisions --model openai/gpt-6-luna-decisions --input - <<'JSON'
{
  "state": { "ticket": "The checkout page crashes when I click Pay." },
  "questions": {
    "is_bug": { "type": "noul", "instructions": "Is this broken product behavior?" },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this?",
      "criteria": { "payments": "Checkout or billing", "other": "Anything else" }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is it?",
      "criteria": ["Can wait", "Fix soon", "Blocking revenue"]
    }
  }
}
JSON
```

`--input` also takes a file path. Add media with repeatable `--image` flags, and for Gemini, `--audio` and `--video`. Answers have this shape:

- `noul`: a probability from 0 to 1
- `choice`: the name of a category
- `score`: a position in the `criteria` list, possibly fractional

```json
{
  "requested_model": "openai/gpt-6-luna-decisions",
  "model": "openai/gpt-6-luna-decisions-20261006",
  "answers": { "is_bug": { "type": "noul", "noul": 0.96 } },
  "usage": { "input_tokens": 100, "output_tokens": 0, "cost": 0.00001 }
}
```

Luna accepts at most 200 questions and up to 64 PNG, JPEG, or WebP images. Gemini accepts the same images, audio, and video as chat. Jev accepts up to 16 PNG or JPEG images, with each side between 256 and 1,568 pixels.

### Chat

```sh
tau tool openrouter chat \
  --model google/gemini-3.8-flash \
  --prompt 'Compare this recording with the reference.' \
  --system 'Separate observations from assumptions.' \
  --video ./recording.mp4 --image ./reference.png --reasoning high
```

Use `--prompt` or `--prompt-file`, and `--system` or `--system-file`. Attachments are `--image` (PNG, JPEG, WebP), and for Gemini only, `--audio` (WAV, MP3) and `--video` (H.264 MP4). Each can repeat.

Stdout has `answer` and `finish_reason`. `stop` means a complete answer, `length` means the answer was cut off, and `content_filter` or a `refusal` field means the model refused. Check these, because all of them exit successfully.

## Outputs and recovery

Output is one JSON object on stdout, with diagnostics on stderr. Failures exit nonzero. Requests are never retried, because the provider may already have charged for one with an unknown result.

Input over Tau's limits fails before sending. Limits include 20 MiB of text, 64 attachments, 32 MiB per image, 256 MiB per audio or video file, and two hours of combined media. A request within these limits can still exceed a model's or provider's limit.
