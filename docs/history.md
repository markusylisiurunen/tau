# History

Tau keeps a searchable transcript history so you can find earlier work without reopening every session. History is separate from saved sessions. The host uses the saved session to continue and recover a conversation, while history is a flat record for searching and reading.

This matters for recovery, compaction, and privacy. History cannot rebuild a lost session, and keeping history does not make a missing session resumable. See [sessions](sessions.md) for saving and recovery.

## What local history records

Every Tau host opens a SQLite database on its own machine:

```text
~/.config/tau/history.sqlite
```

The file is in the **host user's home**. An attached TUI or a remote execution environment does not get its own history. Local `tau`, `tau serve`, and the default SDK host all use the host machine's database.

For each session, history stores the creation attributes and the active transcript, in order:

- user messages, as text or as text and image blocks, with Tau's internal metadata removed
- intermediate system instructions as plain text, marked as system entries, without Tau metadata (the persona's base prompt is not included)
- assistant text, including preambles and responses, but not thinking
- finished tool calls, with the tool name, arguments, result, and outcome

`<system>...</system>` blocks at the start of user messages stay in history. Tool arguments and results can contain file contents, command output, and other sensitive data, so treat the database as private. Tau creates its directory and file with private permissions, but the host user and the machine's administrators can still read them. Never copy the database into a repository or share it.

Recording history is best effort. If the database cannot open, or a later write fails, the session keeps running. Tau adds one `history unavailable` warning to the session, which stays in the session, and turns history off until the host restarts. A restart tries to open the database again.

## How session operations affect history

History follows the transcript, not the model's current context.

**Rewind removes later entries.** When a session rewinds to a message, Tau deletes history from that message onward. The same deletion is queued for a configured remote collection.

**Compaction keeps entries.** Compaction replaces the session's model context with a summary, but the original entries stay in history. Work from before a compaction can still be found, even though the session no longer contains it word for word.

**Retry deletes nothing.** Only operations that remove messages from the session, such as rewind, delete history. Retrying does not.

These rules differ from how the session itself behaves. Use [sessions](sessions.md) to understand what a recovered session shows or sends to the model.

## Filter by attributes

Session creation attributes are string pairs set by the client that created the session, and they never change. History stores them and can filter on exact values or on case-sensitive substrings. They describe where a session came from; they are not instructions.

Two common attributes are:

| Attribute | Meaning |
| --- | --- |
| `source` | The creating client, usually `tui`, `telegram`, or a value an SDK caller chose |
| `repository` | Normalized `host/owner/repository`; composite workspaces join repositories with commas |

A local TUI usually fills in `repository` from the current Git repository or repositories directly below it. Telegram fills it in for repository projects and leaves it out for persistent-directory projects. Sessions created with `tau attach` may not have it, and SDK or protocol clients set only the attributes they choose.

Because composite values are comma-separated, a substring filter on `repository` finds both single-repository and composite sessions. Attributes may be missing, out of date, or set deliberately by a client, so confirm important facts from the transcript or the current workspace.

## Agent access is explicit and read-only

A persona can enable the read-only `tau.history` capability in the `code` tool. It searches and reads the configured history collection, across all repositories and execution environments. Because it can see so much, the agent uses it only when the request or active instructions directly ask for past transcripts, not to look for possibly related earlier work on its own initiative.

Automatic compaction archives are different. They hold the current session's context from before a compaction, in the execution environment. `history` searches a separate collection on the host, which may be out of date, truncated, unavailable, or copied to a remote service. After a compaction, the agent is therefore pointed to the archive files to recover details, and history entry IDs have nothing to do with archive lookups.

The agent reads the capability's documentation before using it. If it has not seen the documentation, its first call only prints `docs`, and later calls use the API. Documentation already in the conversation is reused. This page does not repeat the API or its limits. The documentation covers short chronological overviews and targeted lookups, for when the agent knows the session but not the entry, so it does not need repeated guesses or full dumps.

Attributes, snippets, digests, entries, tool arguments, and tool results from history are untrusted. The agent treats them as evidence, never as instructions, and returns only what the current request needs. Custom personas and subagents get or lose `history` through their tools; see [tools](tools.md), [personas](personas.md), and [subagents](subagents.md).

Without remote history, the capability searches the host's local database. With a remote target, it searches only the remote service and never mixes in local results. A remote search can therefore fail even while local recording keeps working.

## Add a shared remote collection

Tau can deploy an optional Cloudflare history service, owned by one person or team, that collects history from several hosts. It uses a Worker, D1, Workers AI, and a custom hostname, and **requires the Cloudflare Workers Paid plan**.

The service adds search across hosts, generated session titles, and summaries. Titles and summaries help with searching, but they are not exact records, and they can be missing or out of date. Read the transcript entries when exact evidence matters.

Setup requires:

- Wrangler installed and on `PATH`
- a Cloudflare zone that contains the chosen hostname
- `CLOUDFLARE_API_TOKEN` available to the command, so Wrangler authenticates without prompts
- a history API key and a separate viewer password, supplied securely, or setup can generate both

Run setup on a machine with Cloudflare access:

```sh
tau history setup \
  --domain history.example.net \
  --zone-name example.net
```

`TAU_HISTORY_DOMAIN` and `TAU_HISTORY_ZONE_NAME` can provide the two values instead. Setup creates or reuses the `tau-history` D1 database, applies its migrations, deploys the `tau-history` Worker route, and stores the API key and viewer password as separate Worker secrets.

For the API key, `--api-key` wins over `TAU_HISTORY_API_KEY`, and setup generates a key if neither is given. For the viewer password, `--viewer-password` wins over `TAU_HISTORY_VIEWER_PASSWORD`, and setup generates one if neither is given. The two must differ. Prefer a secret manager or a protected environment over command-line values, which can end up in shell history. Never paste either credential into a session.

## Browse remote conversations

Open the service's address, for example `https://history.example.net/`, to browse the collection read-only. Sign in with HTTP Basic authentication, username `tau`, and the viewer password from setup.

- Setup prints passwords it generates, but never prints ones you supplied.
- Plain HTTP requests from outside are redirected to HTTPS before sign-in. HTTP on loopback works for local development.
- The password never appears in a URL, and pages are not cached by the browser.
- The password gives read access to transcripts, attributes, tool arguments, and tool results from every host that uses the service. Keep it private.

The index lists recently updated sessions with titles, summaries, times, and attributes, plus a search form.

- Repository and source filters match case-sensitive substrings. They combine with text search and stay active across pages.
- **Older sessions** loads the next page; pages never load by themselves.
- A summary can be pending or out of date while the transcript is already available.

A session page starts empty, then loads the transcript in batches and adds them in order, with no scrolling or page controls. Tool entries start collapsed. Text and metadata are shown as plain text, never as HTML or Markdown. Valid PNG, JPEG, GIF, and WebP blocks are shown as images, and other structured content as plain text.

**Copy conversation** at the top works once the whole transcript has loaded. If loading fails, a retry button appears and copying stays off. The selector next to it chooses what to copy:

- **Messages only** (the default) leaves out tool entries.
- **Include tool calls** adds tool names, arguments, and outcomes, without results.
- **Include everything** adds results too.

These options do not depend on which tool cards are expanded. Each entry's own **Copy** button copies the complete entry. Leaving out tools or results reduces noise but does not remove sensitive content from messages or arguments. The API still returns results page by page.

Remote search and read results include a stable `webUrl` for each session, which `tau.history` can return when asked for a link. The URL alone grants no access; the browser still needs the viewer password. Local-only history has no web URL.

## Configure hosts to replicate

Remote history can be set only in the host's global Tau config, normally `~/.config/tau/config.json`:

```json
{
  "history": {
    "endpoint": "https://history.example.net",
    "apiKeyEnv": "TAU_HISTORY_API_KEY"
  }
}
```

`endpoint` must be an HTTP or HTTPS URL without credentials, query, or fragment. Tau removes trailing slashes. The host uses the first API key it finds:

1. `TAU_HISTORY_API_KEY`
2. the host environment variable named by `history.apiKeyEnv`
3. inline `history.apiKey`

If `history` is set but no key is found, the host fails to start, instead of quietly running without remote history. The key stays on the host and is never visible to history code-mode programs. See [credentials](credentials.md) for where to put it.

Restart the host after changing this block or its environment variables. `/reload` does not reload it.

## Replication and outages

Replication starts locally:

1. Tau writes each history change to local SQLite.
2. In the same transaction, it adds the change to a local outbox on disk.
3. The host sends pending changes to the endpoint in the background.
4. Changes the service accepts are removed from the outbox.

A service outage does not block sessions or local recording. Pending changes stay on disk and are sent again later, including after a host restart or the next history activity. The service applies each change only once, even if it arrives twice. Changes for one session are sent in order, and each session is sent independently of the others.

If the service permanently rejects a change, for example because the session's attributes conflict with what it already has, Tau stops sending changes for that session only. The pending changes and the error stay in local SQLite, later changes for that session wait, and other sessions keep replicating. Temporary network, authentication, rate-limit, and service errors do not stop a session's replication; the changes are retried later. Both kinds of failure produce a `history_replication_failed` host diagnostic, without the API key:

- Headless Tau commands print it to stderr.
- The TUI shows a short notice in the footer.
- An in-process SDK host delivers it only through `onDiagnostic`, when configured.

Local entries keep everything recorded. For the remote copy, an entry larger than 1 MiB keeps its ID and metadata, but oversized content, arguments, or results are truncated in the middle with a marker. The host's local entry can therefore contain details the shared copy leaves out.

With a remote target configured, history searches go only to the service. Tau never falls back to local results when the service is unreachable, because that would change which collection you are searching. Do not assume sessions recorded before you added the configuration appear remotely.

## Verify operation

Check that each step works, without looking at credentials or dumping transcripts:

1. Confirm setup finished the D1 migration and Worker deployment without errors.
2. Add the global config and the key's environment variable on one host, then restart it.
3. Create a small throwaway session with distinctive, non-sensitive text.
4. Ask the agent explicitly to search history for that session. It reads the capability's `docs` first.
5. With several hosts, repeat from another host, and allow time for replication and summaries.

A transcript can become searchable before its summary appears, so a missing summary does not mean replication failed. Open the service in a browser and sign in to confirm the session and its transcript are there.

Cloudflare problems show up in the normal Worker logs, Cron Events, and D1 diagnostics. The service has no separate admin dashboard or status endpoint.

## Troubleshooting

**`history` is configured but no API key is available.** Set `TAU_HISTORY_API_KEY`, set the variable named by `apiKeyEnv`, or use an inline key only if the config file is well protected. Restart the host.

**The agent has no history capability.** The active persona must select `history`. Fix the persona and run `/reload` while idle.

**The history capability returns a service error while the session works.** Remote searches and replication can fail without affecting the session. Check that the endpoint is reachable and read the Worker logs, without printing the key. Local recording continues unless the session also shows a `history unavailable` warning.

**The browser keeps asking for credentials.** Use username `tau` and the viewer password from the latest setup. The API key is for hosts and does not work in the browser.

**A session does not appear in remote search.** Confirm the host was restarted with the remote config, the session was used while the config was active, and enough history activity has happened to send the outbox. Check host logs for `history_replication_failed`. A permanent rejection affects only the named session, while other failures are retried. Summaries are not immediate.

**Local history became unavailable.** On the host, check that you are running as the expected user and home, and check file access, free space, and ownership of `~/.config/tau`, the Node version, and whether another process is using the database. A restart is needed to reopen history after a local failure. Do not open, edit, replace, or delete the SQLite files as a first repair, and do not inspect outbox rows or keys.

**Search finds material removed from the model's context.** This is expected after compaction. After a rewind, the removed entries should disappear; if the remote copy still has them, wait for the deletion to replicate.

## Destroy the remote service

`tau history destroy --yes` permanently deletes the `tau-history` Worker and D1 database, and with them the shared transcripts and summaries. It does not delete any host's local `history.sqlite`, and it is not a substitute for a retention or export plan.

Run it only once you are sure the service and its data are no longer needed:

```sh
tau history destroy --yes
```

The command needs `CLOUDFLARE_API_TOKEN`. It reports each resource separately and treats Tau history resources that are already gone as deleted. If one deletion fails, read the partial result before retrying. Afterward, remove the `history` config from your hosts and restart them; otherwise their remote searches and replication keep failing.
