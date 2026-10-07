# Models

A model definition tells Tau how to call a provider model and how to reason about its capabilities, limits, and cost. A persona selects one provider and model, while credentials authorize the resulting request. Keeping those layers separate makes it possible to update model metadata without rewriting persona behavior.

Tau ships a versioned catalog and refreshes compatible model metadata from `pi.dev`. The effective catalog for a session therefore depends on the installed Tau version and the host's cached remote catalog.

## Providers, models, and personas

A **provider** owns authentication and one or more request APIs. A **model** is addressed by a provider ID and an exact model ID, such as `openai/gpt-6.1-sol`. A [persona](personas.md) binds that pair to a system prompt, settings, tools, and subagents.

The bundled catalog comes from Tau's model runtime. It supplies known provider IDs, bundled model IDs, request API names, endpoints, capability flags, token limits, and pricing. Bundled does not mean currently usable: a provider may still lack credentials, an account may not expose a model, or a configured endpoint may reject it. See [credentials](credentials.md).

## Remote catalog

A model-owning Tau host restores provider catalogs from `~/.config/tau/models-store.json` during startup, then checks `pi.dev` asynchronously when the cache is older than four hours. This is a startup freshness check, not a recurring timer. Set `TAU_OFFLINE` to skip the automatic network check.

Tau requests one catalog shard for every provider included in its installed `pi-ai` version. Each request has a 15-second timeout and is independent: successful shards are cached even when another provider fails, while failed providers retain their previous valid shard or fall back to bundled metadata. Run `tau models refresh` on the host to bypass the freshness window and force a best-effort refresh. The command exits nonzero if any provider fails after preserving successful updates.

Remote data replaces complete matching `pi-ai` model records and may add model IDs. Tau identifies the installed `pi-ai` version to `pi.dev` so the service can select compatible records. Cached data older than the catalog bundled into `pi-ai` is ignored.

A session captures the available remote catalog when it is created. A background refresh does not change that session. Run `/reload` to adopt the latest host cache; ordinary persona switching keeps the session's captured catalog.

## Unbundled model IDs

Custom personas and subagent launch allowlists may name an unbundled model ID when the provider is known. General model resolution synthesizes the requested ID from that provider's bundled template. This supports newly released IDs but does not discover their capabilities or prices. Prefer IDs present in the bundled or refreshed catalog when accurate metadata matters.

## Model system notices

`modelSystemNotices` belongs in `config.json`, but its keys are validated against the bundled and refreshed model catalog, so it is closely tied to model configuration:

```json
{
  "modelSystemNotices": {
    "openai/gpt-5.7-preview": "Use the preview endpoint only for non-production analysis."
  }
}
```

Keys use exact `<provider>/<model>` form. Provider IDs must be known. Model IDs are case-sensitive and must be bundled or present in the refreshed catalog. Values must be non-empty strings. The map merges by key across configuration levels, with the nearest notice winning.

When Tau commits input for a main agent or subagent using that model, it prepends the notice as a hidden model-facing system block. The block is persisted with the user message and later compaction sees it as source history. Tau does not add a fresh current notice to maintenance prompts or synthetic compaction messages. Ephemeral agents do not receive model system notices.

Use notices for model-specific operational guidance, not credentials or transient secrets. The notice becomes durable session content.

## Applying and verifying changes

Run `/reload` in an idle TUI session after refreshing the model catalog or changing `modelSystemNotices`. Reload resolves runtime content again, reapplies the active persona when its ID still exists, and reports model or configuration warnings. The TUI refuses to reload during an active turn.

For a new local session, this command verifies that the intended persona resolves to the expected provider and model ID without starting the TUI:

```sh
tau --debug --persona release-coder
```

Debug output shows effective persona IDs and selected model IDs, not every model metadata field. It also prints the full effective system prompt and project context, so treat its output accordingly. A small real request is the final check for endpoint, API compatibility, model availability, and credentials.

Unknown providers, unresolved persona models, and notices targeting IDs absent from the catalog produce configuration warnings. In a remote session, warnings identify files on the session target. See [troubleshooting](troubleshooting.md).
