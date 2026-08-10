# Models

A model definition tells Tau how to call a provider model and how to reason about its capabilities, limits, and cost. A persona selects one provider and model, while credentials authorize the resulting request. Keeping those layers separate makes it possible to update model metadata without rewriting persona behavior.

Tau ships a versioned catalog and lets the execution environment overlay it with `models.json`. The effective catalog for a session therefore depends on both the installed Tau version and the session working directory.

## Providers, models, and personas

A **provider** owns authentication and one or more request APIs. A **model** is addressed by a provider ID and an exact model ID, such as `openai/gpt-5.6-sol`. A [persona](personas.md) binds that pair to a system prompt, settings, tools, skills, and subagents.

The bundled catalog comes from Tau's model runtime and Tau-owned extensions. It supplies known provider IDs, bundled model IDs, request API names, endpoints, capability flags, token limits, and pricing. Bundled does not mean currently usable: a provider may still lack credentials, an account may not expose a model, or a configured endpoint may reject it. See [credentials](credentials.md).

Tau applies `models.json` overlays before resolving built-in or custom personas. A bundled persona therefore uses overridden metadata when its provider and model are patched.

## Where `models.json` is loaded

Tau uses the same level discovery as runtime configuration:

- `~/.config/tau/models.json` is the global overlay when the session `cwd` is inside the execution environment's home.
- Every ancestor `.tau/models.json` is a project overlay.
- When `cwd` is inside home, project discovery stops at home. Otherwise it continues to the filesystem root.

Merge order is bundled catalog, global overlay, then project overlays from the farthest parent to the nearest. The nearest value wins for the same field.

These paths belong to the execution environment. In an attached session, edit `models.json` on the session target, not on the TUI machine. The general path rules and reload boundary are covered in [configuration](configuration.md).

## File shape

A `models.json` file has one required `providers` object. Provider keys are normalized to lowercase and must already be known to the bundled catalog.

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://models.internal.example/v1",
      "headers": {
        "x-tenant": "payments"
      },
      "models": [
        {
          "id": "gpt-5.6-sol",
          "contextWindow": 300000,
          "maxTokens": 48000
        },
        {
          "id": "gpt-5.7-preview",
          "name": "GPT-5.7 preview",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 32000,
          "cost": {
            "input": 3,
            "output": 18,
            "cacheRead": 0.3,
            "cacheWrite": 3.75
          }
        }
      ]
    }
  }
}
```

Unknown object fields are discarded. A malformed JSON document or invalid schema rejects that whole file and produces a configuration warning. An unknown provider produces a warning for that provider entry; Tau can still process valid entries from the same file.

## Provider fields

A provider entry accepts these optional defaults:

| Field | Contract |
| --- | --- |
| `api` | Non-empty request API name. It must correspond to an API implementation available in the installed model runtime. |
| `baseUrl` | Non-empty endpoint URL string used for provider models unless a model overrides it. |
| `headers` | String-to-string map merged into model request headers. |
| `compat` | Provider-specific compatibility value. Objects shallow-merge; another JSON value replaces the prior value. |
| `models` | Array of model patches or definitions. |

Provider defaults apply to every effective model for that provider. Across levels, `headers` merge by key and `compat` objects merge one level deep. Other provider fields use the nearest defined value.

Headers are literal strings, not environment references. Prefer the mechanisms in [credentials](credentials.md) for secrets. If a proxy requires a routing header, keep the containing file private and remember that a project overlay may be committed.

## Model fields

Each model entry requires `id`. Its value is trimmed but otherwise exact and case-sensitive. All remaining fields are optional patches:

| Field | Contract |
| --- | --- |
| `id` | Required non-empty model ID. It forms the key with the normalized provider ID. |
| `name` | Non-empty display name. |
| `api` | Non-empty request API name, overriding the provider or bundled value. |
| `baseUrl` | Non-empty endpoint string, overriding the provider or bundled value. |
| `headers` | String-to-string map. Model headers merge over provider headers by key. |
| `reasoning` | Boolean indicating whether the model supports reasoning controls. |
| `input` | Array containing `text`, `image`, or both. The array replaces the prior value. |
| `contextWindow` | Positive integer context-window size in tokens. Tau uses it for context pressure and compaction decisions. |
| `maxTokens` | Positive integer maximum output-token setting. |
| `cost` | Partial rates object described below. Fields merge into prior cost metadata. |
| `compat` | Provider-adapter compatibility value. Objects shallow-merge; another JSON value replaces the prior value. |

A model-level value always overrides the effective provider-level value, even when the model patch came from a broader configuration level. Among model patches for the same provider and ID, the nearest level wins field by field. `headers`, object `compat`, and individual `cost` fields merge; `input` and `cost.tiers` replace their previous arrays.

`compat` is intentionally adapter-specific and is not structurally validated by Tau. Use only keys understood by the selected API implementation. An accepted but unsupported `api` or `compat` value can still fail when a request is made.

## Cost and tiered pricing

Base cost rates are US dollars per million tokens:

```json
{
  "cost": {
    "input": 2,
    "output": 12,
    "cacheRead": 0.2,
    "cacheWrite": 2.5
  }
}
```

Each base field is optional in a patch because omitted values inherit. For a newly synthesized model, inherited provider defaults remain unless replaced.

`cost.tiers` is an array of complete request-wide rates. Every tier requires all five fields:

```json
{
  "cost": {
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 4,
        "output": 18,
        "cacheRead": 0.4,
        "cacheWrite": 5
      }
    ]
  }
}
```

Tau totals input, cache-read, and cache-write usage for the request. When that total is greater than a tier's `inputTokensAbove`, the entire request uses that tier's rates. If several thresholds match, the highest threshold wins. The threshold comparison is strict, so a total exactly equal to the threshold stays on the lower rate.

Keep pricing metadata accurate. Tau uses it for displayed and recorded cost, not only documentation.

## Unbundled model IDs

Custom personas and subagent launch allowlists may name an unbundled model ID when the provider is known. Tau handles it in one of two ways:

1. If merged `models.json` contains the provider and ID, Tau derives a model from that provider's bundled template and applies provider and model patches.
2. Otherwise, general model resolution synthesizes the requested ID from that provider's bundled template and applies provider-level patches.

This supports newly released IDs before Tau bundles them. It does not discover capabilities or prices from the provider. The synthesized definition inherits the first bundled template for that provider, so explicitly define any differing `api`, endpoint, inputs, reasoning support, token limits, compatibility settings, and cost.

A completely new provider cannot be introduced through `models.json`; provider keys must be known to the installed runtime. Also note that `modelSystemNotices` requires a **configured** model. An unbundled ID used only through synthesis must first be listed in `models.json` before a notice can target it.

## Model system notices

`modelSystemNotices` belongs in `config.json`, but its keys are validated against the merged configured model catalog, so it is closely tied to model configuration:

```json
{
  "modelSystemNotices": {
    "openai/gpt-5.7-preview": "Use the preview endpoint only for non-production analysis."
  }
}
```

Keys use exact `<provider>/<model>` form. Provider IDs must be known. Model IDs are case-sensitive and must be bundled or listed in layered `models.json`. Values must be non-empty strings. The map merges by key across configuration levels, with the nearest notice winning.

When Tau commits input for a main agent or subagent using that model, it prepends the notice as a hidden model-facing system block. The block is persisted with the user message and later compaction sees it as source history. Tau does not add a fresh current notice to maintenance prompts or synthetic compaction messages. Ephemeral agents do not receive model system notices.

Use notices for model-specific operational guidance, not credentials or transient secrets. The notice becomes durable session content.

## Applying and verifying changes

Run `/reload` in an idle TUI session after changing `models.json` or `modelSystemNotices`. Reload resolves runtime content again, reapplies the active persona when its ID still exists, and reports model or configuration warnings. The TUI refuses to reload during an active turn.

For a new local session, this command verifies that the intended persona resolves to the expected provider and model ID without starting the TUI:

```sh
tau --debug --persona release-coder
```

Debug output shows effective persona IDs and selected model IDs, not every model metadata field. It also prints the full effective system prompt and project context, so treat its output accordingly. A small real request is the final check for endpoint, API compatibility, model availability, and credentials.

Common warnings and failures include:

- invalid JSON or a missing `providers` object;
- an unknown provider;
- an empty model ID, API, endpoint, or name;
- non-string headers;
- unsupported values in `input`;
- non-positive or non-integer token limits;
- negative cost rates or an incomplete tier;
- a persona that references a provider with no bundled template;
- a notice targeting a model that was never bundled or configured; and
- a syntactically accepted API or compatibility setting that the runtime adapter cannot use.

Warnings identify the exact `models.json` or `config.json` path. In a remote session, that path is in the execution environment. See [troubleshooting](troubleshooting.md) when the edited file and the warning path do not match.
