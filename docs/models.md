# custom model configuration

Tau supports extending and overriding bundled model definitions with `models.json` files.

Supported paths follow the same discovery rules as `config.json`:

- `~/.config/tau/models.json` (global, only when cwd is under home)
- `.tau/models.json` (project, discovered by walking up from cwd to home or filesystem root)

Merge order is parent-first, most specific wins:

- bundled models
- global `models.json`
- project `models.json` files from farthest parent to nearest

## schema

```json
{
  "providers": {
    "openai": {
      "api": "openai-responses",
      "baseUrl": "https://proxy.example.com/v1",
      "headers": {
        "x-custom": "value"
      },
      "compat": {
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-5.4-custom",
          "name": "GPT-5.4 Custom",
          "api": "openai-responses",
          "baseUrl": "https://model-endpoint.example.com/v1",
          "headers": {
            "x-model-header": "value"
          },
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 16384,
          "cost": {
            "input": 1,
            "output": 6,
            "cacheRead": 0.1,
            "cacheWrite": 1.25,
            "tiers": [
              {
                "inputTokensAbove": 272000,
                "input": 2,
                "output": 9,
                "cacheRead": 0.2,
                "cacheWrite": 2.5
              }
            ]
          },
          "compat": {
            "maxTokensField": "max_tokens"
          }
        }
      ]
    }
  }
}
```

Notes:

- Provider keys must be known providers in the loaded Tau model catalog.
- `models[].id` is required. Other model fields are optional.
- Provider-level fields (`api`, `baseUrl`, `headers`, `compat`) apply to all models on that provider.
- Model-level fields override provider-level and bundled values.
- `headers` are merged (provider headers first, model headers override by key).
- `headers` may contain secrets or tenant-specific routing data. Tau uses them only for runtime model calls and does not persist or broadcast them in session protocol snapshots.
- `compat` is shallow-merged.
- `cost.tiers` applies request-wide rates when total input usage exceeds `inputTokensAbove`. The highest matching threshold applies to input, output, cache-read, and cache-write costs for the request.

## behavior for unbundled model ids

Custom personas, custom subagents, and subagent launch allowlists can reference model ids that are not bundled yet, as long as the provider is known.

When Tau sees an unbundled model id:

- If it exists in merged `models.json` config, Tau uses that merged definition.
- Otherwise Tau synthesizes a model definition from provider defaults and requested id.

This lets you use newly released model ids immediately without waiting for a catalog update. Built-in personas use the merged model catalog, so `models.json` can override bundled model definitions.

## example

`.tau/models.json`:

```json
{
  "providers": {
    "openai": {
      "models": [
        {
          "id": "gpt-5.9",
          "contextWindow": 400000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

`.tau/personas/new-model.md`:

```md
---
id: new-model
provider: openai
model: gpt-5.9
---

You are a helpful assistant.
```
