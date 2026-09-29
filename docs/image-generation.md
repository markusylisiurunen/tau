# Image generation

`tau tool image-generate` generates one image from a prompt and optional ordered local references. It calls Google or OpenAI directly, independently of the session model. There is no OpenRouter dependency or session tool registration. Run it through Bash on the machine that owns the files and command credentials.

```bash
tau tool image-generate --help
tau tool image-generate \
  --model gemini-3.1-flash-image \
  --prompt 'A quiet lakeside sauna at dusk, editorial photograph, no text' \
  --aspect-ratio 16:9 --resolution 2K --output ./sauna.png
```

## Credentials and artifacts

Google uses `GEMINI_API_KEY`, then `apiKeys.google`. OpenAI uses `OPENAI_API_KEY`, then `apiKeys.openai`. Tau loads configuration for the invoking command's working directory. These commands do not use Codex OAuth or borrow credentials from an attached host. Agent Bash sanitizes inherited API-key variables; provision private configuration on the execution machine when invoking the command there. Never put keys in prompts or command arguments. See [credentials](credentials.md).

The output's parent directory must exist. Neither the output nor `<output>.parts` may already exist. On success, stdout is one JSON object with absolute `output` and `artifacts` paths and provider `usage` (or `null`). The `.parts` directory retains the original image and `manifest.json` with model and usage. The final output is published only after a complete image is saved, without replacing an existing path, including one created concurrently.

Failures exit nonzero and report the retained artifact directory when generation has started. Requests are not automatically retried: a timeout or broken connection may already have incurred a charge. Choose a fresh output path for another paid attempt. A provider refusal or incomplete response is not a successful image.

## Models and capabilities

`--model` is required and accepts only these native IDs. Omitted controls use provider defaults; PNG is the explicit default output format. Unsupported controls and values fail locally rather than being silently ignored or emulated.

| Model | Resolution | Aspect ratios | Thinking | Other controls |
| --- | --- | --- | --- | --- |
| `gemini-3-pro-image` | `1K`, `2K`, `4K` | Standard | Provider-managed | PNG |
| `gemini-3.1-flash-image` | `512`, `1K`, `2K`, `4K` | Standard and wide | `minimal`, `high` | PNG |
| `gemini-3.1-flash-lite-image` | `1K` | Standard and wide | `minimal`, `high` | PNG |
| `gpt-image-2.5-flare` | Exact `--size` | Through dimensions | Not exposed | Quality, background, encoding, compression |
| `gpt-image-2.5-sunburst` | Exact `--size` | Through dimensions | Not exposed | Quality, background, encoding, compression |

Standard `--aspect-ratio` values are `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. Wide values additionally include `1:4`, `4:1`, `1:8`, `8:1`. Resolution tiers describe approximate output size, not exact dimensions.

OpenAI controls:

- `--size auto` or `WIDTHxHEIGHT`: both dimensions must be multiples of 16, neither above 3840, aspect ratio between 1:3 and 3:1, and total pixels between 655,360 and 8,294,400. Above 2560×1440 total pixels is experimental at the provider.
- `--quality auto|low|medium|high|xhigh|max`: generation effort, not encoding quality. Higher is not always better. Flare favors speed; Sunburst favors demanding editing and quality.
- `--background auto|opaque|transparent`: transparency requires PNG or WebP.
- `--format png|jpeg|webp`: the output extension must match (`.jpg` or `.jpeg` for JPEG). JPEG can reduce latency.
- `--compression 0..100`: an integer, only with JPEG or WebP.

Gemini's `--thinking minimal|high` is separate from OpenAI quality. There is no creativity slider, grounding, mask editing, provider conversation state, `--continue`, batch service, or `--n` option.

## Prompts and editing

Supply exactly one of `--prompt` and `--prompt-file` (UTF-8). Repeat `--reference` for multiple PNG, JPEG, or WebP files. Order and original bytes are preserved, without resizing. OpenAI references use its native edit endpoint. Up to 16 references are accepted for OpenAI and 14 for Gemini; Flash Lite is not optimized for multiple references. Each reference is limited to 50 MB; Gemini's inline reference payload and prompt are limited to approximately 19 MB after base64 encoding.

Create an asset:

```bash
tau tool image-generate \
  --model gpt-image-2.5-flare \
  --prompt 'A friendly otter mascot, isolated, no lettering' \
  --size 1024x1024 --quality medium --background transparent \
  --output ./otter.png
```

Edit with explicit preservation instructions:

```bash
tau tool image-generate \
  --model gpt-image-2.5-sunburst --reference ./otter.png \
  --prompt 'Give the otter a blue scarf. Preserve its face, pose, proportions, and transparent background.' \
  --quality high --background transparent --output ./otter-scarf.png
```

Generative upscaling uses a reference plus a higher resolution. This can alter details and is not pixel-preserving resizing:

```bash
tau tool image-generate \
  --model gemini-3-pro-image --reference ./sauna.png \
  --prompt 'Recreate this image at higher resolution. Preserve composition and colors; refine fine detail.' \
  --aspect-ratio 16:9 --resolution 4K --output ./sauna-4k.png
```

Generate independent variants using ordinary scripting:

```bash
for i in 1 2 3 4; do
  tau tool image-generate --model gemini-3.1-flash-lite-image \
    --prompt-file ./prompt.txt --output "./variant-$i.png" || break
done
```

Reattaching an output as a reference is a stateless edit, not provider-native conversation continuity. Sketches and annotated screenshots can also be references; describe their roles and what may change in the prompt.

## Approximate cost

Illustrative USD image-output estimates: Flash Lite at 1K is about $0.034; Flash at 1K/2K/4K about $0.067/$0.101/$0.151; Pro at 1K–2K/4K about $0.134/$0.24. Input and text/thinking usage are additional. Both OpenAI 2.5 models charge about $0.03 per 1,000 image-output tokens, plus $0.008 per 1,000 image-input tokens and $0.005 per 1,000 text-input tokens. For example, a response using 2,000 image-output tokens costs about $0.06 for output alone; this is not a promise that a particular size or quality uses 2,000 tokens. Inspect reported usage for representative prompts. Variants multiply paid work; account pricing and actual usage determine the bill.
