# Models

A model definition tells Tau how to call a provider's model and what the model can do, including its limits and cost. A persona picks one provider and model, and credentials authorize the request. Because these are separate, model metadata can be updated without changing personas.

Tau ships a model catalog and refreshes compatible metadata from `pi.dev`. The catalog a session sees therefore depends on the installed Tau version and on the host's cached copy of the remote catalog.

## Providers, models, and personas

A **provider** has its own authentication and one or more request APIs. A **model** is named by a provider ID and an exact model ID, such as `openai/gpt-6.1-sol`. A [persona](personas.md) combines a model with a system prompt, settings, tools, and subagents.

The bundled catalog comes from Tau's model library, `pi-ai`. It lists known provider IDs and model IDs, with request API names, endpoints, capabilities, token limits, and pricing. A model in the catalog is not necessarily usable: the provider may lack credentials, the account may not have access to the model, or the endpoint may reject it. See [credentials](credentials.md).

## Remote catalog

A Tau host that runs models loads cached catalogs from `~/.config/tau/models-store.json` at startup. If the cache is older than four hours, it checks `pi.dev` in the background. This check happens only at startup; there is no recurring refresh. Set `TAU_OFFLINE` to skip it.

Tau requests the catalog separately for each provider that its `pi-ai` version supports. Each request has a 15-second timeout. A successful provider is cached even when another fails. A failed provider keeps its previous cached data, or the bundled data if there is none. Run `tau models refresh` on the host to refresh immediately, regardless of cache age. It keeps every successful update and exits nonzero if any provider failed.

Remote data replaces matching model records completely and can add new model IDs. Tau sends its `pi-ai` version to `pi.dev` so the service returns compatible records. Cached data older than the bundled catalog is ignored.

A session keeps the catalog that was available when it was created. A background refresh does not change it. Run `/reload` to use the host's latest cache. Switching personas keeps the session's current catalog.

## Unbundled model IDs

Custom personas and subagent launch allowlists may name a model ID that is not in the catalog, as long as the provider is known. Tau then builds the model from that provider's default template. This lets you use newly released models, but Tau does not know their real capabilities or prices. Prefer IDs from the catalog when accurate metadata matters.

## Model system notices

`modelSystemNotices` is set in `config.json`, and its keys are checked against the model catalog:

```json
{
  "modelSystemNotices": {
    "openai/gpt-5.7-preview": "Use the preview endpoint only for non-production analysis."
  }
}
```

Keys use the exact form `<provider>/<model>`. Provider IDs must be known. Model IDs are case-sensitive and must be in the catalog. Values must be non-empty strings. The map merges by key across configuration levels, and the nearest notice wins.

When a main agent or subagent using that model receives user input, Tau adds the notice to the start of the input as a system block that the model sees and the transcript hides. The block is saved with the user message, and later compaction treats it as part of the history. Maintenance prompts and compaction messages do not get a new notice. Ephemeral agents never receive model system notices.

Use notices for guidance specific to one model. Never put credentials or other secrets in them, because the notice is saved in the session.

## Applying and verifying changes

Run `/reload` in an idle TUI session after refreshing the model catalog or changing `modelSystemNotices`. Reload loads the session's configuration and content again, reapplies the active persona if its ID still exists, and reports model or configuration warnings. The TUI refuses to reload while a turn is running.

To check, without starting the TUI, that a persona resolves to the expected provider and model for a new local session:

```sh
tau --debug --persona release-coder
```

Debug output shows persona IDs and the selected model IDs, but not every metadata field. It also prints the full system prompt and project context, so be careful where you share it. A small real request is the final check for the endpoint, API compatibility, model access, and credentials.

Unknown providers, persona models that cannot be resolved, and notices for IDs missing from the catalog produce configuration warnings. In a remote session, the warnings name files on the session's execution environment. See [troubleshooting](troubleshooting.md).
