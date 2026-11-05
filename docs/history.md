# History

Tau keeps a searchable record of past sessions, separate from saved sessions. History helps you find earlier work, and it cannot restore a session.

## Local history

Each host records its sessions in `~/.config/tau/history.sqlite`, in the host user's home. It stores user messages, assistant text, and finished tool calls with their results, so treat it as private. Thinking and the persona's base prompt are not stored.

Recording is best effort, so history can have gaps. A recording failure does not affect the session, and later entries are still recorded.

Compaction keeps history as it is, so earlier work stays searchable. Rewind deletes entries from the rewind point on.

Each native [subagent](subagents.md) gets its own child session, which stays after a rewind. Claude Code workers are not recorded.

## Agent access

A persona with `history` in `tools` has the read-only `tau.history` API in [`code`](code-mode.md). It can see every recorded session, so the agent uses it only when you or active instructions ask for past transcripts. Ask directly:

```text
Search history for the session where we chose the retry policy, and summarize the decision.
```

Search covers main sessions by default. It can filter on creation attributes such as `repository`, `source`, `machine`, and `cwd`, and it can include child sessions with the `parent` option.

## Shared remote service

Tau can deploy a Cloudflare service, owned by one person or team, that collects history from several hosts. It adds search across hosts, generated titles and summaries, and a web viewer. It needs the Cloudflare Workers Paid plan, Wrangler on `PATH`, and a zone for the hostname.

```sh
export CLOUDFLARE_API_TOKEN='...'
tau history setup --domain history.example.net --zone-name example.net
```

Setup deploys a Worker and a D1 database, and prints an API key and a viewer password if you did not supply them through `--api-key` and `--viewer-password`.

Then configure each host in its global configuration and restart it:

```json
{
  "history": {
    "endpoint": "https://history.example.net",
    "apiKeyEnv": "TAU_HISTORY_API_KEY"
  }
}
```

Tau uses `TAU_HISTORY_API_KEY`, then the variable named by `apiKeyEnv`, then an inline `apiKey`. The host refuses to start if `history` is set and no key is found.

The service stores transcripts and sends their content to Workers AI for summaries, so decide which projects and people should share it. Sessions recorded before you added the configuration may not appear.

To browse, open the service's address and sign in with username `tau` and the viewer password. The password gives read access to everything in the collection. Remote search and read results include a `webUrl` for each session, which still needs the password. Service errors appear in the Worker logs.

## How replication behaves

Each host writes to local SQLite first and sends changes to the service in the background. An outage does not affect sessions, and pending changes are sent later. With a remote target, searches and reads use the service only, and do not fall back to local results. `tau.history.read` can ask for local data with `source: "local"`.

Entries over 1 MiB are shortened in the remote copy, and summaries can lag behind transcripts.

If the service permanently rejects a change, that session's replication stops until you retry it. Other sessions continue. Fix the cause, then run this on the affected host:

```sh
tau history status
tau history retry --session <session-id>
```

## Upgrading

The service and every host must run the same Tau release. Upgrade the service first by running `tau history setup` from the new release with the existing API key and viewer password, then upgrade and restart each host. A host on another release fails remote searches and reads with an invalid response, and an older service loses parent links of child sessions.

## Removing the service

This permanently deletes the Worker, the database, and the shared transcripts. Local databases are not affected:

```sh
tau history destroy --yes
```

Afterwards, remove `history` from each host's configuration and restart it.
