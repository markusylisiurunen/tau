# Image generation

`tau tool image-generate` generates one image from a prompt and optional ordered local references using Google or OpenAI.

```bash
tau tool image-generate --help
tau tool image-generate \
  --model gemini-3.1-flash-image \
  --prompt 'A quiet lakeside sauna at dusk, editorial photograph, no text' \
  --aspect-ratio 16:9 --resolution 2K --output ./sauna.png
```

## Credentials and output

Google uses `GEMINI_API_KEY`, then `apiKeys.google`. OpenAI uses `OPENAI_API_KEY`, then `apiKeys.openai`. Configuration and files belong to the machine running the command. Agent Bash removes inherited API-key variables, so credentials may need to be set in private configuration on that machine. See [credentials](credentials.md).

The output's parent directory must exist. Neither the output nor `<output>.parts` may already exist. On success, stdout is one JSON object with absolute `output` and `artifacts` paths and provider `usage` (or `null`). The `.parts` directory contains:

- `original.bin`: the provider's original image bytes.
- `image.<format>`: the published image. Gemini responses are converted to PNG when needed; OpenAI bytes are saved as returned.
- `manifest.json`: model, output path, usage, and `source` with the original filename and provider-declared MIME type (`null` when absent).

Original bytes and usage remain available if conversion fails. Conversion may discard embedded metadata; use the original when provenance matters.

Failures exit nonzero and report the retained artifact directory when generation has started. Requests are not automatically retried because a failed request may already have incurred a charge.

## Models and capabilities

`--model` is required. Omitted controls use provider defaults, except `--format`, which defaults to `png`. Unsupported options fail before generation.

| Model | Resolution | Aspect ratios | Thinking | Other controls |
| --- | --- | --- | --- | --- |
| `gemini-3-pro-image` | `1K`, `2K`, `4K` | Standard | Provider-managed | PNG |
| `gemini-3.1-flash-image` | `512`, `1K`, `2K`, `4K` | Standard and wide | `minimal`, `high` | PNG |
| `gemini-3.1-flash-lite-image` | `1K` | Standard and wide | `minimal`, `high` | PNG |
| `gpt-image-2.5-flare` | Exact `--size` | Through dimensions | Not exposed | Quality, background, encoding, compression |
| `gpt-image-2.5-sunburst` | Exact `--size` | Through dimensions | Not exposed | Quality, background, encoding, compression |

Standard `--aspect-ratio` values are `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. Wide values additionally include `1:4`, `4:1`, `1:8`, `8:1`. Resolution tiers describe approximate output size.

OpenAI controls:

- `--size auto` or `WIDTHxHEIGHT`: both dimensions must be multiples of 16, neither above 3840, aspect ratio between 1:3 and 3:1, and total pixels between 655,360 and 8,294,400. Above 2560×1440 total pixels is experimental at the provider.
- `--quality auto|low|medium|high|xhigh|max`: generation effort. Flare favors speed; Sunburst favors demanding editing and quality.
- `--background auto|opaque|transparent`: `transparent` requires PNG or WebP.
- `--format png|jpeg|webp`: the output extension must match (`.jpg` or `.jpeg` for JPEG).
- `--compression 0..100`: an integer, only with JPEG or WebP.

Gemini does not support transparent-background generation ([Google documentation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation#stylized_illustrations_and_stickers)). For transparent assets, use an OpenAI model with `--background transparent --format png` or `webp` ([OpenAI documentation](https://developers.openai.com/api/docs/guides/image-generation#size-and-quality-options)).

## Prompts and editing

Supply exactly one of `--prompt` and `--prompt-file` (UTF-8). Repeat `--reference` for local PNG, JPEG, or WebP files. References retain their order and original bytes. OpenAI reference requests use the edit endpoint.

Up to 16 references are accepted for OpenAI and 14 for Gemini; Flash Lite is not optimized for multiple references. Each reference is limited to 50 MB. Gemini's complete serialized request is limited to 19 MB, including the prompt, base64-encoded references, and JSON escaping.

Create an asset:

```bash
tau tool image-generate \
  --model gpt-image-2.5-flare \
  --prompt 'A friendly otter mascot, isolated, no lettering' \
  --size 1024x1024 --quality medium --background transparent \
  --output ./otter.png
```

Edit an existing image:

```bash
tau tool image-generate \
  --model gpt-image-2.5-sunburst --reference ./otter.png \
  --prompt 'Give the otter a blue scarf. Preserve its face, pose, proportions, and transparent background.' \
  --quality high --background transparent --output ./otter-scarf.png
```

Generate at a higher resolution using a reference:

```bash
tau tool image-generate \
  --model gemini-3-pro-image --reference ./sauna.png \
  --prompt 'Recreate this image at higher resolution. Preserve composition and colors; refine fine detail.' \
  --aspect-ratio 16:9 --resolution 4K --output ./sauna-4k.png
```

Generate variants:

```bash
for i in 1 2 3 4; do
  tau tool image-generate --model gemini-3.1-flash-lite-image \
    --prompt-file ./prompt.txt --output "./variant-$i.png" || break
done
```

Each invocation is independent; edits use only the supplied prompt and references.

## Approximate cost

USD image-output estimates: Flash Lite at 1K is about $0.034; Flash at 1K/2K/4K about $0.067/$0.101/$0.151; Pro at 1K–2K/4K about $0.134/$0.24. Input and text/thinking usage are additional.

Both OpenAI 2.5 models charge about $0.03 per 1,000 image-output tokens, $0.008 per 1,000 image-input tokens, and $0.005 per 1,000 text-input tokens. Usage is recorded in the manifest.

See [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) and [OpenAI image pricing](https://developers.openai.com/api/docs/guides/image-generation#gpt-image-25-costs) for current rates.
