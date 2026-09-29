# Speech generation

`tau tool speech-generate` turns a caller-chunked script into one WAV using ElevenLabs `eleven_v4`. It supports single-speaker narration and multi-speaker dialogue.

```bash
tau tool speech-generate --help
```

## Credentials and requirements

Set `ELEVENLABS_API_KEY` or configure `apiKeys.elevenlabs`; the environment variable wins. Configuration and files belong to the machine running the command. Agent Bash removes inherited API-key variables, so credentials may need to be set in private configuration on that machine. See [credentials](credentials.md).

```bash
tau tool speech-generate --list-voices
```

Voice listing prints one JSON object per voice, containing `voice_id` and `name`. Use those IDs in the script.

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
tau tool speech-generate --model eleven_v4 \
  --input ./dialogue.json --output ./dialogue.wav
```

Single-speaker narration uses the same shape with one voice. All chunks are validated before generation:

- Each chunk contains at most 2,000 Unicode code points across its text, including whitespace and delivery tags.
- Every speaker must resolve to a voice. At most 10 distinct voices may be used.

Tau packs consecutive whole chunks into requests of at most 2,000 characters, following the [dialogue endpoint's reliability recommendation](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert). The caller chooses chunk boundaries; text and turn order are preserved.

## Conversational assistant replies

For a brisk, relaxed assistant voice, try either of these delivery tags:

- `[Brisk but relaxed, speaking naturally to a colleague]`
- `[Brisk but relaxed, slightly faster, brief natural pauses]`

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
tau tool speech-generate --model eleven_v4 \
  --input ./assistant-reply.json --output ./assistant-reply.wav
```

For a Finnish reply, replace the turn's `text` with:

```text
[Brisk but relaxed, speaking naturally to a colleague] Löysin ongelman. Sovellus käytti vanhaa asetusta, joten muutoksesi eivät päätyneet palvelimelle. Korjasin asetuksen ja tarkistin, että tallennus toimii. Sinun ei tarvitse asentaa mitään uudelleen. Kokeile tallentaa vielä kerran. Jos varoitus palaa, lähetä minulle sen tarkka teksti, niin selvitän syyn.
```

To compare pacing, replace the leading tag with `[Brisk but relaxed, slightly faster, brief natural pauses]` and generate to a fresh output path, keeping the voice and spoken text fixed.

[Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4) controls delivery through audio tags rather than a numeric speed setting. Results vary by voice and language.

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

The [ElevenLabs API pricing page](https://elevenlabs.io/pricing/api) lists v4 at $0.08 per 1,000 characters, with a promotional $0.022 rate through October 12, 2026. At those rates, 2,000 characters cost approximately $0.16 or $0.044; 27,000 characters (roughly 30 minutes) cost approximately $2.16 or $0.59. Check current API pricing for plan and voice-specific rates. The manifest's `characterCost` preserves the provider's billing header verbatim.

See [command-line tools](tools.md) for command discovery and execution ownership.
