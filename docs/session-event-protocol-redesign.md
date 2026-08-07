# session event protocol redesign

This document records the canonical snapshot/delta session protocol that replaced the old `event`/`session_update` split.

## goals

- A client can attach, render the active session from one authoritative snapshot, and continue by applying deltas.
- Applying `process(oldSnapshot, delta)` reconstructs the next snapshot exactly.
- Revision gaps are detectable and recoverable with a fresh snapshot.
- Ordered transcript placement survives detach and recovery when persistence is intended.
- Ephemeral transcript feedback uses the same ordering domain without becoming recoverable state.
- Model-facing history remains distinct from client-facing session state.
- Mutable semantic state has one canonical owner.

## snapshot ownership

`SessionSnapshot` owns:

- immutable session identity, creation attributes, and creation time
- protocol revision and lifecycle
- durable agent state, including its independent revision and model context key
- goal, settings, bootstrap metadata, catalog, execution environment, and cumulative cost
- complete synchronized model-facing and recoverable messages
- the active ordered timeline
- semantic tool, operation, and subagent maps
- versioned client presentation facets

The timeline is not regenerated from messages or other maps. The host owns it directly:

```ts
interface SessionProtocolTimeline {
  epoch: number;
  sequence: number;
  items: SessionProtocolTimelineItem[];
}
```

`epoch` is a positive monotonically increasing context-era number. `sequence` is the current epoch’s monotonic high-water mark. Timeline items have stable IDs, creation timestamps, and unique sequences in ascending order.

## timeline items

The active timeline contains ordered references or values for four item types:

- `message`, referencing `snapshot.messages`
- `tool`, referencing `snapshot.tools`
- `notice`, carrying a semantic notice value
- `operation`, referencing `snapshot.operations`

Mutable tool and operation lifecycle state stays in keyed maps. Their timeline items establish permanent placement and are not rewritten as state changes.

A message may exist in `snapshot.messages` without a timeline item. This is intentional for model-visible context that should not be rendered in the active transcript, such as automatic-compaction retained tails and hidden continuation messages.

The protocol validates item identity, sequence ordering, epoch consistency, and every message/tool/operation reference. Tool and operation map entries must have exactly one corresponding timeline item.

## notices

A timeline notice is a semantic, versioned value:

```ts
interface SessionProtocolTimelineNotice {
  kind: string;
  version: number;
  severity: "info" | "warn" | "error";
  subject: SessionProtocolSubject;
  presentation: {
    title: string;
    content?: string[];
  };
  data: Record<string, unknown>;
}
```

Notice kinds are open lowercase dotted identifiers. `tau.*` is reserved for Tau core. Clients branch on `kind`, `version`, or live request outcomes, never presentation text, generated IDs, notice counts, or arrival timing.

Provider failure and interruption are already represented by canonical assistant-message state. The host does not emit duplicate durable notices for those states, and the TUI projects their feedback immediately after the affected timeline message. When a turn fails or becomes blocked without a failed assistant message, the host appends one semantic `tau.turn.failed` or `tau.turn.blocked` notice at settlement. A runtime exception successfully settled this way returns an ordinary failed turn outcome instead of a protocol error. Completed request outcomes are returned to the caller but are not duplicated in the snapshot.

## ephemeral feedback

`session.ephemeral` carries three distinct forms of non-snapshot state:

- bounded footer notices
- ordered ephemeral transcript notice items
- ephemeral agent thread updates

An ephemeral transcript item has the same notice timeline-item shape as a durable notice plus the active `epoch`. Before emission, the host persists a `timeline.advance` change that raises the sequence high-water mark. The item itself is not added to `timeline.items` and is not stored.

This gives attached clients canonical ordering while ensuring reattached clients do not recover the item. Persisting the high-water mark prevents a later durable item from reusing its sequence.

A client accepts an ephemeral timeline item when its epoch matches the active snapshot epoch. The host emits it only after persisting its sequence allocation, so a client whose snapshot sequence is temporarily behind during revision recovery still trusts the live item. It merges durable and ephemeral items by sequence.

## deltas

Every `session.delta` contains:

- `fromRevision`
- `toRevision`
- a structured `cause`
- either `snapshot.patch` or `snapshot.reset`

Patch changes are explicit and atomic. Message insertion and timeline placement are separate changes, so a message can intentionally remain context-only. High-rate assistant output uses `message.content.append` rather than repeatedly replacing the accumulated message.

Ordinary delta causes identify user, assistant, tool, notice, agent, maintenance, configuration, and goal transitions. Destructive transitions carry required structure:

- `compaction`: kind, cut, previous epoch, new epoch, and retained-message count
- `rewind`: epoch and cutoff sequence
- `resync`: authoritative recovery synchronization

Clients use these causes rather than inferring transitions from message metadata, operation counts, notice counts, or timing. Delta application validates destructive causes against the current timeline: compaction must name the current epoch as its predecessor, and rewind must name the current epoch with a cutoff no greater than its sequence high-water mark. Deltas targeting an already-observed revision are stale and do not replay presentation transitions.

## compaction

Successful manual or automatic compaction is an epoch replacement:

1. The host clears the active timeline and timeline-owned tool, operation, notice, and presentation state.
2. It increments the epoch exactly once.
3. It keeps the new epoch’s sequence high-water mark at zero until the summary is appended.
4. It appends the compaction summary as the first active timeline item.
5. It publishes a reset with a structured compaction cause.

Optional automatic-compaction retained-tail and continuation messages remain model-visible in `snapshot.messages`, but they do not receive timeline items.

Failed, skipped, or aborted compaction remains in the current epoch. Its operation stays at the point where it occurred.

A client present for a successful transition may freeze the previous epoch as immutable client-local presentation and start a `compacted context` segment. That frozen history is not persisted or reconciled. A client attaching later sees only the current recoverable epoch. The compaction operation is also the sole host-owned activity state: clients derive running presentation from it rather than coordinating a second ephemeral start/finish lifecycle.

## rewind

Rewind removes the selected message and all later active state. The host determines the selected item’s sequence and resets to the same epoch with a cutoff immediately before it.

The reset removes every timeline item after the cutoff, including messages, tools, notices, and operations, then reconciles the semantic maps and facets to the retained state. Attached clients also remove ephemeral timeline items after the cutoff.

The timeline sequence remains at its previous high-water mark. New items continue above it, so sequence values are never reused after rewind.

## recovery and storage migration

Current runtime and wire contracts use only the canonical timeline shape. Compatibility for shipped filesystem sessions is confined to the storage migration boundary.

The version-5-to-version-6 storage migration converts older array timelines into epoch 1. It reconstructs historical tool placement once, moves embedded operation values into `snapshot.operations`, normalizes legacy operation terminal fields and notices, converts meaningful persisted failed/blocked message outcomes into semantic turn notices, drops redundant completed outcomes, and renames the old agent context fingerprint to `modelContextKey`. Current-version documents must already use the canonical shape before ordinary protocol validation applies.

Recovery discards supervised subagent runtime state and agent-owned facets because those runtimes do not survive process restart. It finishes persisted running maintenance operations as cancelled with a completion time and `session-recovered` reason because their execution cannot survive, while retaining their timeline placement. Durable timeline order and the semantic data needed to open the session remain recoverable.

## pending messages and other live state

Queued and steering user messages are not timeline items. They use a separate full-replacement `session.pendingUserMessages` channel with an independent revision. They are shared among clients attached to the same in-memory session and start empty on recovery.

Ephemeral agent threads use their dedicated live event family. They are not folded into snapshot timeline state.

## client rules

A conforming client:

- installs the observe snapshot and pending-message baselines before processing buffered events
- verifies delta revision continuity
- applies protocol deltas rather than reconstructing snapshot state independently
- renders active transcript order from `timeline.items`
- reads mutable tool and operation state through timeline references
- merges accepted ephemeral transcript items by `(epoch, sequence)`
- discards old-epoch ephemeral items on compaction and post-cutoff items on rewind
- treats frozen prior epochs as optional client-local presentation
- refreshes with `session.snapshot` after a revision gap
