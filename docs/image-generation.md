# Image generation

`tau tool image-generate` generates one image from a prompt and optional reference images. `tau tool image-generate --help` lists every flag.

## Credentials and requirements

OpenAI models need `OPENAI_API_KEY` or `apiKeys.openai`. Google models need `GEMINI_API_KEY` or `apiKeys.google`.

## Models

`--model` is required. Start with `gpt-image-2.6-flare` at `--quality medium`. For the best quality, use one of the others.

| Model | Size control | Notes |
| --- | --- | --- |
| `gpt-image-2.6-flare` | `--size WIDTHxHEIGHT` | Fast. Transparency, PNG, JPEG, and WebP. |
| `gpt-image-2.6-sunburst` | `--size WIDTHxHEIGHT` | Demanding edits. Same options as Flare. |
| `gemini-nano-banana-2.1` | `--aspect-ratio`, `--resolution 1K\|2K\|4K` | Very wide ratios, PNG only, no transparency. |

OpenAI sizes must be multiples of 16, at most 3840 per side, with an aspect ratio between 1:3 and 3:1. `--quality` goes from `low` to `max`. `--complexity low` suits focused edits, and `medium` or `high` suit dense text and layouts.

## Input and examples

Give `--prompt` or `--prompt-file`. Repeat `--reference` for each local PNG, JPEG, or WebP image. Each run is independent, so an edit sees only what you pass.

```bash
tau tool image-generate \
  --model gpt-image-2.6-flare \
  --prompt 'A friendly otter mascot, isolated, no lettering' \
  --size 1024x1024 --quality medium --background transparent \
  --output ./otter.png

tau tool image-generate \
  --model gpt-image-2.6-flare --reference ./otter.png \
  --prompt 'Give the otter a blue scarf. Preserve its face, pose, and background.' \
  --quality high --complexity low --background transparent --output ./otter-scarf.png

tau tool image-generate \
  --model gemini-nano-banana-2.1 --reference ./sauna.png \
  --prompt 'Recreate this image at higher resolution. Preserve composition and colors.' \
  --aspect-ratio 16:9 --resolution 4K --output ./sauna-4k.png
```

## Outputs and recovery

The output and `<output>.parts` must not exist yet. Stdout is one JSON object with `output`, `artifacts`, and `usage`. The `.parts` directory keeps the original image and a manifest, so if only the final copy fails, copy the finished image instead of generating again. Requests are never retried, because a failed request may already have been charged.

## Approximate cost

For OpenAI models at `1024x1024`, one image costs about $0.025 at `low`, $0.043 at `medium`, $0.053 at `high`, and $0.211 at `max`, plus input. `gemini-nano-banana-2.1` costs about $0.034 at 1K, $0.050 at 2K, and $0.113 at 4K, plus input and thinking. Check provider pricing before large batches.
