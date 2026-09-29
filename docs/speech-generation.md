# Speech generation

`tau tool speech-generate` turns a caller-chunked script into one WAV using ElevenLabs Eleven v4 Turbo (`eleven_v4_turbo`) or Eleven v4 (`eleven_v4`). It supports single-speaker narration and multi-speaker dialogue.

```bash
tau tool speech-generate --help
```

## Credentials and requirements

Requires an ElevenLabs API key. See [feature-specific credentials](credentials.md#feature-specific-keys) for setup.

```bash
tau tool speech-generate --list-voices
```

Voice listing prints one JSON object per voice, containing `voice_id` and `name`. Use those IDs in the script.

## Models

`--model` is required; the CLI has no implicit default. Use `eleven_v4_turbo` for lower-latency speech, as shown in the examples. Use `eleven_v4` when maximum quality matters more than latency. Both support narration and multi-speaker dialogue.

## Input and examples

Supply a UTF-8 JSON document with exactly `voices` and `chunks`. `voices` maps speaker names to voice IDs; `chunks` is an ordered, nonempty array of nonempty arrays of speaker turns. Each turn contains exactly `speaker` and nonblank `text`.

```json
{
  "voices": {
    "host": "VOICE_ID_A",
    "guest": "VOICE_ID_B"
  },
  "chunks": [
    [
      {
        "speaker": "host",
        "text": "[calm] Welcome. What are we exploring today?"
      },
      {
        "speaker": "guest",
        "text": "How a forest changes through the seasons."
      }
    ],
    [
      { "speaker": "host", "text": "Let's begin with spring." },
      {
        "speaker": "guest",
        "text": "The first changes happen before the leaves appear."
      }
    ]
  ]
}
```

Save as `dialogue.json`, replacing the placeholder voice IDs:

```bash
tau tool speech-generate --model eleven_v4_turbo \
  --input ./dialogue.json --output ./dialogue.wav

# Alternatively, use Eleven v4 for maximum quality.
tau tool speech-generate --model eleven_v4 \
  --input ./dialogue.json --output ./dialogue-v4.wav
```

Single-speaker narration uses the same shape with one voice. All chunks are validated before generation:

- Each chunk contains at most 2,000 Unicode code points across its text, including whitespace and delivery tags.
- Every speaker must resolve to a voice. At most 10 distinct voices may be used.

Tau packs consecutive whole chunks into requests of at most 2,000 characters, following the [dialogue endpoint's reliability recommendation](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert). The caller chooses chunk boundaries; text and turn order are preserved.

## Conversational assistant replies

For conversational assistant replies with Eleven v4 Turbo or Eleven v4, use `[Brisk but relaxed, speaking naturally to a colleague]` as a starting point. Put the tag at the beginning of the turn's `text`, followed by the words to speak. Tags guide delivery; they are not intended to be spoken aloud.

Choose a delivery that fits the content:

| Use case | Suggested tag |
| --- | --- |
| Everyday assistant reply | `[Brisk but relaxed, speaking naturally to a colleague]` |
| Faster update | `[Brisk but relaxed, slightly faster, brief natural pauses]` |
| Step-by-step explanation | `[Calm and clear, measured pace, brief pauses between steps]` |
| Story narration | `[Warm, expressive storytelling, unhurried pace]` |
| Quiet aside in dialogue | `[whispering]` |

These are custom prompting suggestions, not official named presets or guaranteed speed controls. Each speaker turn can use a different tag; place a tag before a phrase when the delivery should change within a turn.

ElevenLabs documents open-ended audio tags in its [v4 prompting guide](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4), also available as [plain Markdown](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices.md#prompting-eleven-v4). Its [documentation index](https://elevenlabs.io/docs/llms.txt) lists other guides in an agent-friendly format.

Documented tags include `[curious]`, `[excited]`, `[sarcastic]`, `[whispering]`, `[laughs]`, `[sighs]`, and `[short pause]`. For example, a turn's `text` can contain:

```text
[curious] What happens if we try the other route?

[excited] That worked! [short pause] Here's what changed.

[Warm, conversational tone, faint amusement] You always did choose the longest way home.
```

Tags describe audible delivery or vocal actions, not visual actions such as smiling or standing. Clear descriptions reduce ambiguity between a delivery instruction and a sound effect. Results vary by voice and language; neither Eleven v4 Turbo nor Eleven v4 treats tags as deterministic controls.

Save this as `assistant-reply.json`, replacing `VOICE_ID` with an ID from `--list-voices`:

```json
{
  "voices": { "assistant": "VOICE_ID" },
  "chunks": [
    [
      {
        "speaker": "assistant",
        "text": "[Brisk but relaxed, speaking naturally to a colleague] I found the issue. The app was using an old setting, so your changes never reached the server. I've fixed that and checked the result. You don't need to reinstall anything. Try saving once more. If the warning comes back, send me the exact message and I'll trace it from there."
      }
    ]
  ]
}
```

```bash
tau tool speech-generate --model eleven_v4_turbo \
  --input ./assistant-reply.json --output ./assistant-reply.wav

# Alternatively, use Eleven v4 for maximum quality.
tau tool speech-generate --model eleven_v4 \
  --input ./assistant-reply.json --output ./assistant-reply-v4.wav
```

For a Finnish reply, replace the turn's `text` with:

```text
[Brisk but relaxed, speaking naturally to a colleague] Löysin ongelman. Sovellus käytti vanhaa asetusta, joten muutoksesi eivät päätyneet palvelimelle. Korjasin asetuksen ja tarkistin, että tallennus toimii. Sinun ei tarvitse asentaa mitään uudelleen. Kokeile tallentaa vielä kerran. Jos varoitus palaa, lähetä minulle sen tarkka teksti, niin selvitän syyn.
```

To compare pacing, replace the leading tag with `[Brisk but relaxed, slightly faster, brief natural pauses]` and generate to a fresh output path, keeping the voice and spoken text fixed.

[Eleven v4 Turbo and Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4) control delivery through audio tags rather than a numeric speed setting. Results vary by voice and language.

## Long recordings and assembly

Responses are streamed to disk as mono 24 kHz, signed 16-bit little-endian PCM. Batches are concatenated in order into one WAV. Approximately 30 minutes occupies 86.4 MB of PCM. Each batch is capped at 128 MiB and the assembled file must fit standard RIFF/WAV's roughly 4 GiB limit. Provider requests have a ten-minute deadline.

Each request receives up to three previous completed request IDs for ElevenLabs request stitching. A missing ID stops subsequent generation. Stitching uses normal ElevenLabs request logging.

## Outputs and recovery

The output parent directory must exist. Neither the requested WAV nor `<output>.parts` may exist. The `.parts` directory contains:

- `manifest.json`: model, PCM format, output path, request plan, text and voice IDs, one-based chunk indices, completion flags, and byte counts. `requestId` and `characterCost` retain the provider's `request-id` and `character-cost` headers, including when a subsequent audio download fails.
- `batch-0001.pcm`, etc.: completed raw PCM batches in request order.
- `.partial` files: interrupted downloads.
- `assembled.wav`: the assembled output.

Stdout on success is one JSON object with absolute `output`, `artifacts`, and the number of `batches`. The manifest contains the script text; keep artifacts private for sensitive scripts.

Failures exit nonzero and report the retained directory. Requests are not automatically retried because a failed request may already have incurred a charge.

To recover after a later batch fails, inspect the manifest's `completed` flags and chunk mapping. Generate only the unfinished chunks to a fresh output path, then assemble the completed PCM files from both runs in script order. Request stitching does not carry over between invocations.

For example, with FFmpeg installed:

```bash
cat ./first.wav.parts/batch-0001.pcm \
    ./first.wav.parts/batch-0002.pcm \
    ./remaining.wav.parts/batch-0001.pcm > ./complete.pcm
ffmpeg -n -f s16le -ar 24000 -ac 1 -i ./complete.pcm -c:a pcm_s16le ./complete.wav
```

Use only completed `.pcm` batches, not `.partial` files.

## Approximate cost

Standard rates from the [ElevenLabs API pricing page](https://elevenlabs.io/pricing/api):

| Model | Per 1,000 characters | 2,000 characters | 27,000 characters (roughly 30 minutes) |
| --- | --- | --- | --- |
| `eleven_v4_turbo` | $0.04 | $0.08 | $1.08 |
| `eleven_v4` | $0.08 | $0.16 | $2.16 |

Check current API pricing for plan and voice-specific rates. The manifest's `characterCost` preserves the provider's billing header verbatim.

See [command-line tools](tools.md) for command discovery and execution ownership.
