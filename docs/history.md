# History

Tau keeps a searchable record of past sessions, separate from saved sessions. History helps you find earlier work, and it cannot restore a session.

## Local history

Each host records its sessions in `~/.config/tau/history.sqlite`, in the host user's home. It stores user messages, assistant text, and finished tool calls with their results, so treat it as private. Thinking and the persona's base prompt are not stored.

A recording failure leaves a gap in history, but the session keeps running and later entries are still recorded. When the session closes, Tau reports the failure and keeps the session locked until that Tau process exits. `tau run` exits nonzero if its session's history is incomplete.

Compaction keeps history as it is, so earlier work stays searchable. Rewind deletes entries from the rewind point on.

Each [subagent](subagents.md) gets its own child session, which stays after a rewind.

## Agent access

The agent has the read-only `@tau/history` API in [`code`](code-mode.md). It can see every recorded session, so the agent uses it only when you or active instructions ask for past transcripts. Ask directly:

```text
Search history for the session where we chose the retry policy, and summarize the decision.
```

Search covers main sessions by default. It can filter on creation attributes such as `repository`, `source`, `machine`, and `cwd`, and it can include child sessions with the `parent` option.

## Export a transcript

`tau history read <id>` prints a session's whole recorded transcript from this host's history database as JSON. `--format markdown-compact` gives readable text with tool payloads shortened, and `markdown-full` keeps them in full. The JSON lists child sessions in `session.childSessionIds`. `--schema` prints the JSON Schema, and `--source remote` reads from the shared service described below.

## Import transcripts

`tau history import` adds sessions recorded by other tools, so they can be searched and read like Tau sessions. It reads a JSON array of sessions with their entries from stdin, and `--schema` prints its format. Entries use the same shape as `tau history read` output.

Give each session and entry a stable ID, and rerun the import with the whole transcript when it grows. Entries already in history are skipped, and new ones are appended in input order. A session's `createdAt` and `attributes` cannot change after the first import. Set an attribute such as `source` to tell imported sessions apart in search.

With the shared service configured, imported entries replicate like any other. Entries imported without it stay local. A later import skips them as existing entries, so configuring the service afterwards does not upload them. `--require-remote` prevents this by failing before it writes anything when this host has no remote configured.

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

Each host writes to local SQLite first and sends changes to the service in the background. An outage does not affect sessions, and pending changes are sent later. With a remote target, `@tau/history` searches and reads use the service only, and do not fall back to local results. `read` from `@tau/history` can ask for local data with `source: "local"`.

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
