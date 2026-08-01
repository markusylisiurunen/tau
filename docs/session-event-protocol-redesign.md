# session event protocol redesign

This document records the snapshot/delta session protocol design that replaced the old `event`/`session_update` split.

## problem

The current protocol sends two different live channels:

- `event`, which carries core runtime events such as assistant partials, tool UI events, notices, subagent UI events, and compaction lifecycle events.
- `session_update`, which tells clients that the authoritative snapshot changed and should be refreshed.

That split makes the session only partly reconstructable. A client that observes the whole stream can render rich state, but a client that starts from `session.snapshot` cannot reconstruct the same state because important facts are only present in side-channel events:

- Tool progress is UI-shaped and not stored as semantic session state.
- Notices are not model-facing and are not stored in the snapshot.
- Subagent progress is live-only.
- Automatic compaction lifecycle is live-only except for the final rewritten history.
- The snapshot contains the active assistant partial as a special side object instead of as part of the message log clients already render.

The protocol should instead make the snapshot the only renderable source of truth. Live events should be deterministic deltas over that snapshot.

## goals

- A client can attach, call `session.snapshot`, and render the full current UI from that snapshot.
- A client can process live updates with `process(oldSnapshot, delta) -> newSnapshot`.
- If the client misses a delta, it can detect the revision gap and call `session.snapshot`.
- There is one live session update channel, not separate runtime-event and snapshot-update channels.
- Model-facing history remains distinct from client-facing session state.
- Non-model-facing structured metadata can be attached to model-facing records without encoding it in tool result text.
- Event and delta names are symmetrical, domain-shaped, and stable.
- Complex rebases such as reload, rewind, and compaction are allowed to send a full replacement snapshot instead of large bespoke patch sequences.

## core invariant

Every live message that describes session state is a state transition:

```ts
function process(
  snapshot: SessionSnapshot,
  message: SessionDeltaMessage,
): SessionSnapshot {
  if (message.delta.type === "snapshot.reset") {
    if (message.delta.snapshot.revision !== message.toRevision) {
      throw new InvalidDeltaError();
    }
    return message.delta.snapshot;
  }

  if (snapshot.revision !== message.fromRevision) {
    throw new RevisionGapError();
  }

  const next = applyPatch(snapshot, message.delta);
  next.revision = message.toRevision;
  return next;
}
```

`revision` is the protocol state revision. It increments when observable session state changes, including streaming assistant partials and tool progress. It is not a disk persistence revision.

## wire message

The protocol replaces `event` and `session_update` with one observed-session message:

```ts
type SessionDeltaMessage = {
  version: 4;
  type: "session.delta";
  sessionId: string;
  fromRevision: number | null;
  toRevision: number;
  reason: SessionDeltaReason;
  delta: SessionDelta;
};
```

`fromRevision` is `null` only when the delta is a full reset that can be applied without a prior snapshot.

```ts
type SessionDeltaReason =
  | "user-message"
  | "assistant-stream"
  | "assistant-message"
  | "tool-run"
  | "tool-result"
  | "notice"
  | "agent-run"
  | "maintenance"
  | "configuration"
  | "recovery";

type SessionDelta =
  | {
      type: "snapshot.patch";
      changes: SessionChange[];
    }
  | {
      type: "snapshot.reset";
      snapshot: SessionSnapshot;
    };
```

The names deliberately separate transport shape from domain cause:

- `session.delta` is the live wire message.
- `snapshot.patch` means "apply these changes to your current snapshot".
- `snapshot.reset` means "replace your snapshot with this complete one".
- `reason` is for client policy, logging, and animations; correctness comes from the delta.

## snapshot

The snapshot should be renderable without live event history:

```ts
type SessionSnapshot = {
  sessionId: string;
  revision: number;
  agentState: {
    revision: number;
    contextEpoch: string;
    usageCheckpoint?: {
      historyEntryId: string;
      contextEpoch: string;
      tokens: number;
    };
  };

  lifecycle: "idle" | "running";
  settings: SessionSettingsSnapshot;
  bootstrap: SessionBootstrapSnapshot;
  catalog: SessionContentCatalogSnapshot;
  executionEnvironment: SessionExecutionEnvironmentSnapshot;

  messages: SessionMessage[];
  timeline: SessionTimelineItem[];
  tools: Record<string, SessionToolRun>;
  agents: Record<string, SessionAgentRun>;
  facets: Record<string, SessionFacet>;
};
```

`agentState.revision` is the durable conversation revision and is independent of the protocol snapshot revision. The context epoch and optional provider usage checkpoint let recovery preserve automatic-compaction accounting when the execution-ready agent spec is unchanged.

### settings, bootstrap, and catalog

`settings` are the small mutable knobs that define how the next turn runs.

```ts
type SessionSettingsSnapshot = {
  personaId: string;
  reasoning?: ReasoningEffort;
  serviceTier?: "priority" | "flex";
};
```

`bootstrap` describes resolved runtime facts that clients need to understand the session: selected model/provider metadata and prompt-composition identifiers. Execution environment identity lives in the top-level `executionEnvironment` snapshot field. Bootstrap should not duplicate large prompt bodies or mutable per-turn settings that already live in `settings`.

There should not be a broad `runtimeConfig` blob in the snapshot. If a config value is needed by clients, promote it to an explicit field in `settings`, `bootstrap`, or `catalog`. If it is only used by the host, keep it host-side.

The effective system instructions are represented as the first item in `messages`, not as a side field. They are static for the session. Explicit reload operations can replace the snapshot with a new first system message.

```ts
type SessionSystemMessage = {
  role: "system";
  content: string;
  timestamp: number;
};
```

`catalog` is lightweight and session-specific. It is for discovery and fast client affordances, not for caching all execution-environment content. For example, prompt catalog entries should include `id`, `label`, and optional `description`, but not the full template body. When a prompt is invoked, the host loads the latest prompt content from the execution environment at that moment. The same rule applies to skills, personas, subagents, available reasoning levels, and similar session-owned content.

Themes are not part of the session snapshot. Theme selection and theme files are TUI-local presentation state and should be read from disk where the TUI runs.

```ts
type SessionPromptCatalogEntry = {
  id: string;
  label?: string;
  description?: string;
};
```

This keeps snapshots small and avoids stale cached prompt bodies while preserving autocomplete and client navigation.

### messages

`messages` are the complete session transcript. This is the replacement for `historyEntries`.

```ts
type SessionMessage = {
  id: string;
  state: "draft" | "committed" | "interrupted" | "discarded";
  modelVisible: boolean;
  message: SessionProtocolMessage;
};

type SessionProtocolMessage =
  | SessionSystemMessage
  | Message
  | {
      role: "assistant";
      content: (TextContent | ThinkingContent | ToolCall)[];
      timestamp: number;
    };
```

The first committed message is the system message. User messages, assistant messages, tool calls, and tool results follow in session order. `messages` is the complete synchronized transcript, including model-facing entries that may not appear on the default UI timeline. Draft assistant messages are updated in place while streaming. When the model response completes, the same message is replaced with a committed assistant message containing final provider metadata and usage.

If the user interrupts mid-stream, the streamed assistant content is retained. The draft is replaced with `state: "interrupted"` and remains available for rendering and future model context. The default is `modelVisible: true`; use `modelVisible: false` only for records that are intentionally excluded from future model input.

The client should be able to inspect every message, regardless of whether the default chat surface chooses to show it prominently. Tool result message text remains model-facing; client-only structured data belongs in `facets`.

This removes the need for `activeTurn`. "Currently running" is derived from snapshot state: `lifecycle === "running"`, draft/interrupted messages, running tools, running agents, and running operations. On interrupt, the host applies ordinary changes: mark the draft assistant message `interrupted`, cancel or finish running tools/agents/operations, and set `lifecycle` to `idle` when cleanup finishes.

### timeline

`timeline` is the default conversation-surface projection. It controls what the standard client surface renders and in what order. It is allowed to omit messages. Omitted messages are not hidden from clients because they still live in `messages`; advanced clients can render the full transcript from `messages` directly.

```ts
type SessionTimelineItem =
  | { type: "message"; id: string; messageId: string }
  | { type: "notice"; id: string; notice: SessionNotice }
  | { type: "operation"; id: string; operation: SessionOperation };

type SessionNotice = {
  severity: "info" | "warn" | "error";
  text: string;
  timestamp: number;
};

type SessionOperation = {
  kind: "auto-compaction" | "manual-compaction" | "reload" | "rewind";
  status: "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  data?: Record<string, unknown>;
};
```

This is how notices become reconstructable. They are not model messages, but they are session records.

### tools

`tools` stores semantic tool execution state keyed by tool call id.

```ts
type SessionToolRun = {
  id: string;
  toolCallId: string;
  toolName: string;
  call: {
    messageId: string;
    contentIndex: number;
  };
  status:
    "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
  startedAt?: number;
  finishedAt?: number;
  resultMessageId?: string;
  summary?: string;
  error?: string;
  facetIds: string[];
};
```

Clients render known tools by reading the assistant `toolCall` arguments, the matching `SessionToolRun`, the matching tool result message when present, and any attached facets. Unknown tools still have a stable fallback: render the tool name, arguments, status, result text, and generic facets.

### agents

`agents` stores subagent state. Subagent state is no longer a side-channel panel event.

```ts
type SessionAgentRun = {
  id: string;
  name: string;
  title: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  originMessageId: string;
  modelLabel?: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextWindowUsageTokens: number;
    contextWindow: number;
  };
  startedAt: number;
  finishedAt?: number;
  abortRequested: boolean;
  progress?: string;
  finalText?: string;
  error?: string;
};
```

### facets

`facets` are typed, client-facing, non-model-facing structured metadata attached to canonical session records.

```ts
type SessionFacet = {
  id: string;
  subject: SessionFacetSubject;
  kind: string;
  version: number;
  data: Record<string, unknown>;
};

type SessionFacetSubject =
  | { type: "session" }
  | { type: "message"; id: string }
  | { type: "tool"; id: string }
  | { type: "agent"; id: string }
  | { type: "operation"; id: string };
```

Facet examples:

```ts
{
  id: "facet-tool-call-123-bash",
  subject: { type: "tool", id: "call-123" },
  kind: "tool.bash.execution",
  version: 1,
  data: {
    command: "npm run check",
    cwd: "/repo",
    exitCode: 0,
    durationMs: 12403,
    truncated: false
  }
}
```

```ts
{
  id: "facet-tool-call-456-diff-review",
  subject: { type: "tool", id: "call-456" },
  kind: "tool.diff-review.session",
  version: 1,
  data: {
    reviewedFiles: ["src/protocol/session_protocol.ts"],
    reviewAgents: [{ threadId: "review-1", status: "success" }]
  }
}
```

Facets are the extension point. Adding richer client rendering for a tool should usually add or update a facet, not invent a new protocol event.

## patch changes

Patch changes are intentionally small and regular:

```ts
type SessionChange =
  | { type: "lifecycle.set"; lifecycle: SessionSnapshot["lifecycle"] }
  | {
      type: "message.append";
      message: SessionMessage;
      timelineItem?: SessionTimelineItem;
    }
  | { type: "message.replace"; message: SessionMessage }
  | {
      type: "message.content.append";
      messageId: string;
      text?: string;
      thinking?: string;
      timestamp: number;
    }
  | { type: "timeline.append"; item: SessionTimelineItem }
  | { type: "timeline.replace"; item: SessionTimelineItem }
  | { type: "timeline.remove"; id: string }
  | { type: "tool.set"; tool: SessionToolRun }
  | { type: "tool.remove"; id: string }
  | { type: "agent.set"; agent: SessionAgentRun }
  | { type: "agent.remove"; id: string }
  | { type: "facet.set"; facet: SessionFacet }
  | { type: "facet.remove"; id: string };
```

`message.append.timelineItem` is optional. The message append itself keeps all clients synchronized with the full transcript. The optional timeline item only says that the default conversation surface should render that message. This supports model-facing messages that are intentionally absent from the UI while still remaining fully reconstructable from `messages`.

`message.content.append` is for high-rate assistant streaming. It appends non-empty text and/or thinking content to an existing draft assistant message without resending the full accumulated message on every frame. It only targets draft assistant messages. When an append creates a thinking block, clients insert it before the text block so applying the patch still reconstructs the next snapshot exactly.

For broad rewrites, do not overfit patch changes:

- `session.reload`: `snapshot.reset`
- `session.setReasoning`: `settings.set`
- `session.setPersona`: `snapshot.reset`
- `session.compact`: `snapshot.reset`
- `session.rewind`: `snapshot.reset`

Those operations already return authoritative snapshots and can change multiple independent areas at once. Reset is simpler and less error-prone than a long patch.

## typical flows

### user submission

```json
{
  "type": "session.delta",
  "fromRevision": 10,
  "toRevision": 11,
  "reason": "user-message",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.append",
        "message": {
          "id": "msg-user-1",
          "state": "committed",
          "modelVisible": true,
          "message": { "role": "user" }
        },
        "timelineItem": {
          "type": "message",
          "id": "tl-user-1",
          "messageId": "msg-user-1"
        }
      },
      { "type": "lifecycle.set", "lifecycle": "running" }
    ]
  }
}
```

### assistant stream

The first assistant chunk appends a draft message. Later chunks append text or thinking to the same draft message with `message.content.append`.

```json
{
  "type": "session.delta",
  "fromRevision": 11,
  "toRevision": 12,
  "reason": "assistant-stream",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.append",
        "message": {
          "id": "msg-assistant-1",
          "state": "draft",
          "modelVisible": false,
          "message": {
            "role": "assistant",
            "timestamp": 1782800000000,
            "content": [{ "type": "text", "text": "I will inspect" }]
          }
        },
        "timelineItem": {
          "type": "message",
          "id": "tl-assistant-1",
          "messageId": "msg-assistant-1"
        }
      }
    ]
  }
}
```

Later stream update:

```json
{
  "type": "session.delta",
  "fromRevision": 12,
  "toRevision": 13,
  "reason": "assistant-stream",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.content.append",
        "messageId": "msg-assistant-1",
        "text": " inspect the protocol",
        "timestamp": 1782800000000
      }
    ]
  }
}
```

### interrupt during assistant stream

Interrupting does not need a separate turn object. The draft message is kept as transcript state and marked interrupted.

```json
{
  "type": "session.delta",
  "reason": "assistant-stream",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.replace",
        "message": {
          "id": "msg-assistant-1",
          "state": "interrupted",
          "modelVisible": true,
          "message": {
            "role": "assistant",
            "timestamp": 1782800000000,
            "content": [
              { "type": "text", "text": "I will inspect the protocol" }
            ]
          }
        }
      },
      { "type": "lifecycle.set", "lifecycle": "idle" }
    ]
  }
}
```

### assistant final with tool call

Replace the same draft assistant message with the committed final assistant message, then attach tool run records for each assistant tool call.

```json
{
  "type": "session.delta",
  "reason": "assistant-message",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.replace",
        "message": {
          "id": "msg-assistant-1",
          "state": "committed",
          "modelVisible": true,
          "message": { "role": "assistant" }
        }
      },
      {
        "type": "tool.set",
        "tool": {
          "id": "call-1",
          "toolCallId": "call-1",
          "toolName": "bash",
          "call": { "messageId": "msg-assistant-1", "contentIndex": 1 },
          "status": "queued",
          "facetIds": []
        }
      }
    ]
  }
}
```

### tool completion

```json
{
  "type": "session.delta",
  "reason": "tool-result",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.append",
        "message": {
          "id": "msg-tool-1",
          "state": "committed",
          "modelVisible": true,
          "message": { "role": "toolResult" }
        },
        "timelineItem": {
          "type": "message",
          "id": "tl-tool-1",
          "messageId": "msg-tool-1"
        }
      },
      {
        "type": "tool.set",
        "tool": {
          "id": "call-1",
          "toolCallId": "call-1",
          "toolName": "bash",
          "call": { "messageId": "msg-assistant-1", "contentIndex": 1 },
          "status": "succeeded",
          "resultMessageId": "msg-tool-1",
          "summary": "exit 0",
          "facetIds": ["facet-call-1-bash"]
        }
      },
      {
        "type": "facet.set",
        "facet": {
          "id": "facet-call-1-bash",
          "subject": { "type": "tool", "id": "call-1" },
          "kind": "tool.bash.execution",
          "version": 1,
          "data": { "exitCode": 0, "durationMs": 218, "truncated": false }
        }
      }
    ]
  }
}
```

### notice

```json
{
  "type": "session.delta",
  "reason": "notice",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "timeline.append",
        "item": {
          "type": "notice",
          "id": "notice-1",
          "notice": {
            "severity": "warn",
            "text": "auto-retrying after transient error",
            "timestamp": 1782800000000
          }
        }
      }
    ]
  }
}
```

### compaction

Automatic compaction can show a running operation, then reset the full snapshot when history is rewritten.

```json
{
  "type": "session.delta",
  "reason": "maintenance",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "timeline.append",
        "item": {
          "type": "operation",
          "id": "op-1",
          "operation": {
            "kind": "auto-compaction",
            "status": "running",
            "startedAt": 1782800000000
          }
        }
      }
    ]
  }
}
```

Then:

```json
{
  "type": "session.delta",
  "fromRevision": null,
  "toRevision": 42,
  "reason": "maintenance",
  "delta": {
    "type": "snapshot.reset",
    "snapshot": {
      "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
      "revision": 42
    }
  }
}
```

## client rendering model

The client should not receive UI events. It should render from snapshot state:

- Conversation rows come from `timeline`.
- Message timeline items dereference `messages`. Not every message must have a timeline item.
- Full transcript views, debugging views, and protocol clients that need model context read directly from `messages`.
- Notices are timeline records.
- Tool cards are rendered from assistant `toolCall` blocks plus `tools[toolCall.id]`, matching tool result messages, and facets.
- Subagent panels are rendered from `agents`.
- Active assistant text is rendered from the current draft assistant message, whether or not the UI chooses to expose all other messages.
- Running maintenance is rendered from timeline operations.

Known tool renderers can use typed facets. Unknown tools can still render name, arguments, status, result content, and facet summaries.

## implementation checklist

1. Snapshot-owned stores: `timeline`, `tools`, `agents`, and `facets`.
2. Internal runtime events translated into `SessionChange[]` at the host boundary.
3. Host wraps changes as `session.delta` messages with strict revision increments.
4. Tool UI payloads are stored as `SessionToolRun` updates and typed facets before they cross the protocol boundary.
5. Notices are timeline notice records.
6. Subagent UI events are stored as `agents` updates.
7. `snapshot.reset` is used for reload, persona changes, rewind, and compact; reasoning changes use `settings.set`.
8. Transports and SDK listeners expose `session.delta`; ephemeral agent progress uses `session.ephemeral`.
9. TUI rendering is driven from snapshots and local delta application.
10. Themes stay in TUI-local config/content loading rather than the session protocol.
11. Wire-level `eventVersion`, `event`, `tool_ui`, and `session_update` semantics are removed from the session protocol.

This is a breaking protocol change, which is appropriate before v1. Avoid aliases or compatibility shims.
