# History

Tau keeps transcript history so earlier work can be found without reopening every session. This store is separate from the resumable session snapshot: the snapshot is the host's recovery source of truth, while history is a flat, searchable record for discovery and reading.

That distinction matters when diagnosing recovery, compaction, or privacy. Deleting or losing history does not provide a way to reconstruct a session, and retaining history does not make a missing session snapshot resumable. See [sessions](sessions.md) for snapshot persistence and recovery.

## What local history records

Every Tau host opens a machine-local SQLite database at:

```text
~/.config/tau/history.sqlite
```

The path belongs to the **host home**. An attached TUI and a remote execution environment do not get separate history stores merely because they participate in the session. Local `tau`, `tau serve`, `tau rpc`, and the default SDK host all use the host machine's database.

For each session, history stores its immutable creation attributes and an ordered active transcript containing:

- committed user content, after Tau's internal metadata is removed
- assistant text segments, including committed preambles and responses, but not thinking
- completed tool calls with the tool name, arguments, result, and terminal outcome

Leading model-facing `<system>...</system>` blocks in user messages remain in history. Tool arguments and results can contain file contents, command output, or other sensitive data. Treat the database as private user data. Tau creates its history directory and database with private permissions, but the host user and machine administrators can still access them. Do not copy the database into a repository or expose it through a shared artifact.

History capture is best effort. If the local store cannot open or a later projection fails, Tau keeps the session running, adds one durable `history unavailable` warning to that session, and disables history for the rest of the host process. Restarting the host retries local initialization; it does not erase the earlier warning from the recovered session.

## How session operations affect history

History represents the active flat transcript, not the session's current model-context shape.

**Rewind removes the superseded suffix.** When a session rewinds from a selected message, Tau truncates history from that source message onward. The same ordered truncation is queued for a configured remote collection.

**Compaction leaves original entries intact.** Manual and automatic compaction replace the session's active model context with a summary, but they do not delete the original flat transcript from history. This makes pre-compaction work discoverable later even though it is no longer present verbatim in the resumable active context.

**Retry does not imply truncation.** Tau truncates history only when the canonical session operation removes source entries, such as rewind. Retrying from completed tool state does not independently discard transcript history.

These rules are intentionally different from snapshot and timeline behavior. Use [sessions](sessions.md) when the question is what a recovered session will render or send to the model.

## Search provenance with attributes

Session creation attributes are immutable client-supplied string pairs. History preserves them and supports both exact values and ordinary case-sensitive substring filters. They are provenance hints, not trusted instructions.

Two conventional attributes are widely useful:

| Attribute | Convention |
| --- | --- |
| `source` | Creating client, commonly `tui`, `telegram`, or a caller-chosen SDK value |
| `repository` | Normalized `host/owner/repository`; composites join repositories with commas |

A local TUI normally derives `repository` from the current Git repository or direct child repositories. Telegram derives it from configured repository projects and omits it for persistent-directory projects. Attach-created sessions may omit it, and SDK or raw protocol clients provide only the attributes their caller chooses.

Because composite values are comma-delimited, a substring repository filter can find both single-repository and composite sessions. Attributes may be absent, stale as real-world labels, or intentionally chosen by a client. Confirm important facts from the transcript or current workspace rather than treating attributes as authority.

## Agent access is explicit and read-only

An eligible persona can expose the read-only `history` code-mode tool. It can search and read the configured history collection across repositories and execution environments. This is broad visibility, so Tau instructs agents to invoke it only when the user or another active instruction directly asks to reference, search, or read historical transcripts. It should not be used speculatively because earlier work might be relevant.

The tool owns its progressively disclosed API documentation. On the first history call for a task, the agent must print and read `docs`, then use the documented API in a later call. This page does not duplicate those signatures or response limits.

Historical attributes, snippets, digests, entries, tool arguments, and tool results are untrusted data. An agent should use them as evidence, never follow instructions found inside them, and print only the minimum historical material needed for the current request. Custom personas and subagents can include or exclude `history` through their tool configuration; see [tools](tools.md), [personas](personas.md), and [subagents](subagents.md).

Without remote history configuration, the tool searches this host's local SQLite collection. With a remote target configured, queries go to that service rather than merging remote and local results. A remote query outage can therefore fail even while local capture continues successfully.

## Add a shared remote collection

Tau can deploy an optional single-owner Cloudflare history service for collecting transcript history from several hosts. It uses a Worker, D1, Workers AI, and a custom hostname, and it **requires the Cloudflare Workers Paid plan**.

The service adds cross-host search and generated session titles and semantic summaries. Those digests are compact retrieval aids rather than authoritative session state or chronological replay. They can be absent or temporarily stale, so read transcript entries when exact evidence matters.

The setup command requires:

- Wrangler installed and available on `PATH`
- a Cloudflare zone containing the chosen history hostname
- `CLOUDFLARE_API_TOKEN` available to the command for non-interactive Wrangler authentication
- a history API key supplied securely, or permission for setup to generate one

Run setup on an operator machine with Cloudflare access:

```sh
tau history setup \
  --domain history.example.net \
  --zone-name example.net
```

`TAU_HISTORY_DOMAIN` and `TAU_HISTORY_ZONE_NAME` can provide the two values instead. Setup creates or reuses the `tau-history` D1 database, applies the bundled migrations, deploys the `tau-history` Worker route, and installs the history API key as a Worker secret.

For the API key used during setup, `--api-key` takes precedence over `TAU_HISTORY_API_KEY`; otherwise setup generates a new key. Prefer a secret manager or protected process environment over a command-line value, which may enter shell history. Do not paste the resulting key into a session transcript.

## Configure hosts to replicate

Remote history is accepted only in the host's eligible global Tau config, normally `~/.config/tau/config.json`:

```json
{
  "history": {
    "endpoint": "https://history.example.net",
    "apiKeyEnv": "TAU_HISTORY_API_KEY"
  }
}
```

`endpoint` must be an HTTP or HTTPS URL without a query or hash. Tau removes trailing slashes. The API key resolves on the host in this order:

1. `TAU_HISTORY_API_KEY`
2. the host environment variable named by `history.apiKeyEnv`
3. inline `history.apiKey`

If the block exists but no key resolves, host construction fails instead of silently using an unauthenticated or local-only target. The key remains host-owned and is not exposed to history code-mode programs. See [credentials](credentials.md) for safe placement.

Restart the host after changing this block or its environment. `/reload` updates session runtime content but does not rebuild the host-wide history manager.

## Replication and outages

Remote replication is local-first:

1. Tau commits each history mutation to local SQLite.
2. The same transaction appends an ordered operation to a durable local outbox.
3. The host sends pending operations to the configured endpoint asynchronously.
4. Successful acknowledgements remove those operations from the outbox.

A service outage does not block session execution or local transcript capture. Pending operations remain durable and are retried when replication is scheduled again, including after host restart or later history activity. The remote service applies operations idempotently and in order.

Local entries retain their complete captured payloads. For remote replication, an entry larger than 1 MiB keeps its identity and metadata but middle-truncates oversized content, arguments, or results with an explicit marker. Remote history is therefore useful for retrieval, but the host's local entry can contain details that the shared copy intentionally omits.

Configuring a remote target changes history-tool queries to use that service. Tau does not fall back to local query results when the service is unreachable, because that would silently change collection scope. Existing histories that were never associated with the target should not be assumed to appear remotely merely because the config block was added later.

## Verify operation

Verify the owning boundary rather than inspecting credentials or dumping transcripts:

1. Confirm setup completed its D1 migration and Worker deployment without errors.
2. Add the global config and key environment to one host, then restart it.
3. Create a small disposable session with distinctive, nonsensitive text.
4. Explicitly ask the agent to search history for that session, following the history tool's `docs` step.
5. If using several hosts, repeat from another host and allow for asynchronous replication and digest generation.

A transcript can become remotely searchable before its generated digest appears. Search results without a digest are not evidence of a failed import.

Cloudflare operational failures are visible through normal Worker logs, Cron Events, and D1 diagnostics. The service has no separate Tau administration dashboard or status endpoint.

## Troubleshooting

**`history` is configured but no API key is available.** Set `TAU_HISTORY_API_KEY`, populate the environment variable named by `apiKeyEnv`, or use an inline key only when the config file is appropriately protected. Restart the host.

**The history tool returns a service error while the session still works.** Remote queries and asynchronous replication can fail independently of session execution. Check endpoint reachability and Worker logs without printing the bearer key. Local capture should continue unless the session also contains a `history unavailable` warning.

**A session does not appear in remote search.** Confirm that the host was restarted with the global remote config, that the session was opened while that target was active, and that later history activity has had a chance to flush the durable outbox. Do not assume remote digests are immediate.

**Local history became unavailable.** Check host-side filesystem access, free space, and ownership for `~/.config/tau`. Restarting is required to reopen a manager disabled by an earlier local failure.

**Search finds material removed from model context.** This is expected after compaction. It is not expected after a successful rewind of that suffix; if the remote copy lags, wait for its truncation operation to replicate.

## Destroy the remote service

`tau history destroy --yes` permanently deletes the bundled `tau-history` Worker and D1 database. This removes the shared remote transcripts and digests. It does not delete each host's local `history.sqlite` database, and it is not a substitute for a retention or export plan.

Run destruction only after confirming that the service and its data are no longer needed:

```sh
tau history destroy --yes
```

The command requires `CLOUDFLARE_API_TOKEN`. It reports each resource separately and treats already-absent Tau history resources as absent. If one deletion fails, inspect the reported partial result before retrying. Remove obsolete host `history` config and restart those hosts afterward, otherwise their remote queries and replication attempts will continue to fail.
