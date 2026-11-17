# Speech generation

`tau tool speech-generate` turns a script into one WAV file using ElevenLabs. It supports narration and multi-speaker dialogue.

## Credentials and requirements

Needs `ELEVENLABS_API_KEY` or `apiKeys.elevenlabs`. List voices, printed as one JSON object each with `voice_id` and `name`:

```bash
tau tool speech-generate --list-voices
```

## Input and examples

`--model` is required. Use `eleven_v4_turbo` for lower latency and `eleven_v4` for the highest quality.

```json
{
  "voices": { "host": "VOICE_ID_A", "guest": "VOICE_ID_B" },
  "chunks": [
    [
      { "speaker": "host", "text": "[calm] What are we exploring today?" },
      {
        "speaker": "guest",
        "text": "How a forest changes through the seasons."
      }
    ],
    [{ "speaker": "host", "text": "Let's begin with spring." }]
  ]
}
```

```bash
tau tool speech-generate --model eleven_v4_turbo \
  --input ./dialogue.json --output ./dialogue.wav
```

Each chunk holds at most 2,000 characters, including tags, and a script uses at most 10 voices. You choose where chunks break, and Tau keeps the text and order.

## Delivery tags

Tags in square brackets guide how text is spoken and are not read aloud. Results vary by voice and language.

| Use | Tag |
| --- | --- |
| Everyday assistant reply | `[Brisk but relaxed, speaking naturally to a colleague]` |
| Faster update | `[Brisk but relaxed, slightly faster, brief natural pauses]` |
| Step-by-step explanation | `[Calm and clear, measured pace, brief pauses between steps]` |
| Story narration | `[Warm, expressive storytelling, unhurried pace]` |

Short tags such as `[curious]`, `[whispering]`, `[laughs]`, and `[short pause]` also work. Tags describe sound, so avoid visual actions. See the [ElevenLabs prompting guide](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4).

## Outputs and recovery

The output is mono 24 kHz 16-bit WAV. Neither the output nor `<output>.parts` may exist yet. Stdout is one JSON object with `output`, `artifacts`, and `batches`.

`.parts` holds `manifest.json`, the completed `batch-0001.pcm` files, and `assembled.wav`. The manifest contains the script text, so keep it private if the script is sensitive.

Requests are never retried, because a failed request may already have been charged. If a later batch fails, check the manifest's `completed` flags and generate only the unfinished chunks to a new path. Then join the PCM files in order, leaving out `.partial` files:

```bash
cat ./first.wav.parts/batch-0001.pcm ./remaining.wav.parts/batch-0001.pcm > ./complete.pcm
ffmpeg -n -f s16le -ar 24000 -ac 1 -i ./complete.pcm -c:a pcm_s16le ./complete.wav
```

## Approximate cost

Per 1,000 characters, `eleven_v4_turbo` costs about $0.04 and `eleven_v4` about $0.08. Thirty minutes is roughly 27,000 characters. The manifest records the provider's `characterCost`.
