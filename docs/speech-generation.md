# Speech generation

`tau tool speech-generate` turns a caller-chunked script into one WAV using ElevenLabs `eleven_v4`. It supports existing voices, single-speaker narration, and multi-speaker dialogue. The command owns request batching and audio assembly, not script writing or automatic text splitting. It is independent of `/speak`, Telegram voice responses, and the session model. Music, sound effects, voice creation, and cloning are not supported.

## Credentials and voices

Set `ELEVENLABS_API_KEY` or configure `apiKeys.elevenlabs`; the environment variable wins. Configuration and files belong to the machine running the command. Agent Bash removes inherited API-key variables, so command-local private configuration may be needed. Host credentials are not forwarded to execution environments. See [credentials](credentials.md).

```bash
tau tool speech-generate --list-voices
```

Voice listing prints one JSON object per voice, containing `voice_id` and `name`, following all provider pages. Use those IDs in the script. Voice availability, consent, and plan restrictions remain provider-controlled.

## Input contract

Supply a UTF-8 JSON document with exactly `voices` and `chunks`. `voices` maps speaker names to existing voice IDs; `chunks` is an ordered, nonempty array of nonempty arrays of speaker turns. Each turn contains exactly `speaker` and nonblank `text`.

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

Single-speaker narration uses the same shape with one voice. For long narration, the caller supplies more chunks at suitable boundaries. All chunks are validated before any generation:

- Each chunk contains at most 2,000 Unicode code points across all its text, including whitespace and delivery tags.
- Every speaker must resolve to a voice. At most 10 distinct voices may be used.
- Tau preserves text, delivery tags, turn order, and speaker assignments. It never invents split points, rewrites text, or truncates a script.

The adapter greedily packs consecutive whole chunks into requests of at most 2,000 characters. Chunk boundaries are not a promise of one request per chunk, a pause, or a reset. This conservative budget follows the [dialogue endpoint's reliability recommendation](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert) rather than the [model's larger advertised capacity](https://elevenlabs.io/docs/overview/models#eleven-v4).

## Conversational assistant replies

For an assistant speaking directly to the listener, short first-person replies and restrained delivery cues can help avoid a theatrical or narration-like style. These tags are useful starting points:

- `[Brisk but relaxed, speaking naturally to a colleague]`
- `[Brisk but relaxed, slightly faster, brief natural pauses]`

For example, save this as `assistant-reply.json`, replacing `VOICE_ID` with an ID from `--list-voices`:

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

To compare pacing, replace only the leading tag with `[Brisk but relaxed, slightly faster, brief natural pauses]` and generate to a fresh output path. Keep the voice and spoken text fixed. Listen for natural phrasing, pronunciation, and completeness, not just a shorter recording.

Tags are delivery cues, not precise speed controls; their effect varies by voice, language, and generation. [Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4) does not expose a numeric speed setting or support SSML. Tau passes the tags through without rewriting them or accelerating the resulting audio.

## Long recordings and assembly

Each request asks for mono 24 kHz, signed 16-bit little-endian PCM. Responses are streamed to disk, then assembled in order under one valid WAV header. There is no MP3-header concatenation, inserted silence, automatic crossfade, or whole-recording memory buffer. Approximately 30 minutes occupies 86.4 MB of PCM; there is no 32 MiB recording limit. Each batch is capped at 128 MiB and the assembled file must fit standard RIFF/WAV's roughly 4 GiB limit. Provider requests have a ten-minute deadline and are not automatically retried.

After completely consuming a response, the adapter passes up to three previous request IDs to the next dialogue request for provider-side request stitching. This is transient speech conditioning, not a saved conversation or a `--continue` workflow. The dialogue API documents stitching as model-dependent: request acceptance does not guarantee naturalness or identical delivery across joins. Listen across batch boundaries before approving a long recording. Missing request IDs stop further generation rather than silently dropping conditioning. Requests use normal provider logging; zero-retention mode is not exposed because it disables stitching.

## Outputs and partial failure

The output parent directory must exist. Neither the requested WAV nor `<output>.parts` may exist. The `.parts` directory contains:

- `manifest.json`: model, PCM format, output path, request plan, original speaker/text inputs, one-based input chunk indices, completion flags, and byte counts. `requestId` and `characterCost` retain the provider's `request-id` and `character-cost` headers when supplied, including when a subsequent audio download fails. `characterCost` is the raw billing header, not a count of input characters or proof of spoken completeness.
- `batch-0001.pcm`, etc.: completed raw PCM batches in request order.
- `.partial` files: interrupted or invalid downloads, not approved for reuse.
- `assembled.wav`: the complete local assembly, published at the requested output path only after success.

Stdout on success is one JSON object with absolute `output`, `artifacts`, and the number of `batches`. An existing output is never replaced, even if created concurrently. The manifest includes script content, so keep artifacts private when the text is sensitive.

Failures exit nonzero and report the retained directory. A later failed batch does not discard completed PCM. No partial recording is published as the successful final WAV. A timeout may already have been billed; Tau does not retry automatically or provide automatic resume.

To avoid regenerating completed speech after failure, inspect `manifest.json`. Prepare a new input with only the unfinished chunks and a fresh output path. Do not include completed chunks again. Generate the remaining speech, then locally assemble the completed raw PCM files from both artifact directories in order. Provider continuity from the original run is not restored by this manual recovery.

For example, with FFmpeg installed, after verifying these are exactly the completed batches in script order:

```bash
cat ./first.wav.parts/batch-0001.pcm \
    ./first.wav.parts/batch-0002.pcm \
    ./remaining.wav.parts/batch-0001.pcm > ./complete.pcm
ffmpeg -n -f s16le -ar 24000 -ac 1 -i ./complete.pcm -c:a pcm_s16le ./complete.wav
```

Never concatenate `.wav` files as raw bytes or include `.partial` files. Concatenating the retained raw PCM adds no silence or crossfade. A reported successful provider response can still omit or mispronounce words; validate completeness by listening.

## Approximate cost

The [ElevenLabs API pricing page](https://elevenlabs.io/pricing/api) lists v4 at $0.08 per 1,000 characters, with a promotional $0.022 rate through October 12, 2026. At those rates, 2,000 characters cost approximately $0.16 or $0.044 respectively; 27,000 characters (roughly 30 minutes at 900 characters/minute) cost approximately $2.16 or $0.59. These are planning estimates, not duration guarantees or per-call invoices. Check current API pricing, plan allowances, and voice-specific rates before a long generation; do not assume one credit per input character. The manifest's `characterCost` preserves the provider's billing header verbatim, while account usage determines the actual charge. Repeated generations consume additional quota.
