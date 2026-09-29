# Image generation

`tau tool image-generate` generates one image from a prompt and optional ordered local references using Google or OpenAI.

```bash
tau tool image-generate --help
tau tool image-generate \
  --model gpt-image-2.5-flare \
  --prompt 'A quiet lakeside sauna at dusk, editorial photograph, no text' \
  --size 1536x1024 --quality medium --output ./sauna.png
```

## Credentials and requirements

Requires an OpenAI or Google API key for the selected model. See [feature-specific credentials](credentials.md#feature-specific-keys) for setup.

## Models and capabilities

`--model` is required; the CLI has no implicit default. Start with `gpt-image-2.5-flare` at `--quality medium` for everyday generation and editing. Increase quality or choose `gpt-image-2.5-sunburst` when precise edits justify the extra effort. See [approximate cost](#approximate-cost) before choosing settings.

Choose size, resolution, and aspect ratio for the intended use; there is no recommended universal size. Dimensions in the examples illustrate particular use cases. Omitted controls use provider defaults, except `--format`, which defaults to `png`. Unsupported options fail before generation.

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

## Input and examples

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
  --model gpt-image-2.5-flare --reference ./otter.png \
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

Generate inexpensive draft variants:

```bash
for i in 1 2 3 4; do
  tau tool image-generate --model gpt-image-2.5-flare \
    --size 1024x1024 --quality low \
    --prompt-file ./prompt.txt --output "./variant-$i.png" || break
done
```

Each invocation is independent; edits use only the supplied prompt and references.

## Outputs and recovery

The output's parent directory must exist. Neither the output nor `<output>.parts` may already exist. On success, stdout is one JSON object with absolute `output` and `artifacts` paths and provider `usage` (or `null`). The `.parts` directory contains:

- `original.bin`: the provider's original image bytes.
- `image.<format>`: the published image. Gemini responses are converted to PNG when needed; OpenAI bytes are saved as returned.
- `manifest.json`: model, output path, usage, and `source` with the original filename and provider-declared MIME type (`null` when absent).

Original bytes and usage remain available if conversion fails. Conversion may discard embedded metadata; use the original when provenance matters.

Failures exit nonzero and identify the invalid option or failed processing stage. Existing output or artifact paths require a fresh `--output` path; preserve retained recovery artifacts. Once generation starts, errors report the retained directory, which may be empty or incomplete. If final publication fails, the error points to the completed image to copy to a fresh path without generating again. Requests are not automatically retried because a failed request may already have incurred a charge; another generation request may incur another charge.

## Approximate cost

Use Flare for fast everyday images and drafts; reserve Sunburst for demanding edits where preservation and precision matter most. Start at `medium`, use `low` for inexpensive exploration, and increase quality only when the result needs it. Explicit `--size` and `--quality` make budgeting more predictable than `auto`.

### OpenAI: cost per image

Both `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` charge $30 per million image-output tokens. The [OpenAI output-cost calculator](https://developers.openai.com/api/docs/guides/image-generation#gpt-image-25-and-gpt-image-2-output-tokens) groups both models under GPT Image 2.5 and gives these approximate USD image-output costs:

| Size        | `low`    | `medium` | `high`   | `xhigh`  | `max`    |
| ----------- | -------- | -------- | -------- | -------- | -------- |
| `1024x1024` | $0.00588 | $0.01317 | $0.05268 | $0.09366 | $0.21072 |
| `1536x1024` | $0.00474 | $0.01029 | $0.04116 | $0.07377 | $0.16464 |
| `2048x2048` | $0.01191 | $0.02676 | $0.10704 | $0.19029 | $0.42816 |
| `3840x2160` | $0.01113 | $0.02595 | $0.10008 | $0.17790 | $0.40026 |

These are calculator estimates, not fixed prices or a guarantee that Flare and Sunburst cost the same per request. OpenAI notes that actual token consumption can differ by model and quality. The calculator accounts for aspect ratio as well as pixel count, so estimates need not increase with pixel count alone. Sizes above 2560×1440 total pixels are experimental.

For example, 100 square 1024-pixel drafts at `low` have an estimated output cost of $0.59, compared with $1.32 at `medium`, $5.27 at `high`, or $21.07 at `max`. Text input adds $5 per million tokens and reference images add $8 per million image-input tokens. A request with 1,000 text-input tokens and 2,000 image-input tokens adds $0.021 to the output cost. Direct Images API requests do not receive cached-input pricing. The manifest records provider `usage` for checking actual consumption.

### Google: cost per image

Approximate USD image-output costs from [Google pricing](https://ai.google.dev/gemini-api/docs/pricing), excluding input and text/thinking usage:

| Model | 1K | 2K | 4K | When to choose it |
| --- | --- | --- | --- | --- |
| `gemini-3.1-flash-lite-image` | $0.034 | Unsupported | Unsupported | Simple 1K images; not optimized for multiple references |
| `gemini-3.1-flash-image` | $0.067 | $0.101 | $0.151 | Resolution tiers and very wide aspect ratios |
| `gemini-3-pro-image` | $0.134 | $0.134 | $0.24 | Higher-resolution reference-based work with standard aspect ratios |

Use OpenAI when transparent backgrounds or JPEG/WebP output are required. Compare the quality needed for the task, not just matching tier names across providers. Check [OpenAI pricing](https://developers.openai.com/api/docs/guides/image-generation#gpt-image-25-costs) and Google pricing for current rates before large batches.

See [command-line tools](tools.md) for command discovery and execution ownership.
