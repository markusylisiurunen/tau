// @preload ./workflow.js
//
// Shared selection, reading, screening, and classification for the history
// workflows, exposed as globalThis.history.

globalThis.history = (() => {
  const { inParallel, logStart, tokens, ensure } = workflow;

  const DECISION_MODEL = "typesafe/jev-1.14";

  // Limits in tokens, estimated like Tau at six bytes per token.
  const MAX_TAIL_TOKENS = 8192;
  const MAX_SCREEN_BATCH_TOKENS = 65_536;
  const CHUNK_TOKENS = 65_536;

  // Each session needs at least one history read and usually a model call,
  // and a code job can make 4,096 API requests in total.
  const MAX_SESSIONS = 512;
  const MAX_SCREEN_BATCH_SESSIONS = 32;

  // At most 262,144 bytes, so a single entry always fits in one chunk.
  const MAX_ENTRY_CHARS = 65_536;

  // Jev probabilities. Screening keeps uncertain sessions.
  const SCREEN_THRESHOLD = 0.15;
  const CLASSIFY_THRESHOLD = 0.6;

  // ── Selection ───────────────────────────────────────────────────────────

  function readSelection(input) {
    const { since, until, scopes = [{}], sessionIds } = input ?? {};
    const start = since === undefined ? -Infinity : Date.parse(since);
    const end = until === undefined ? Date.now() : Date.parse(until);
    ensure(
      tau.agents && tau.bash && tau.history && tau.models,
      "This workflow requires Tau's agents, bash, history, and models capabilities",
    );
    ensure(
      since !== undefined || sessionIds !== undefined,
      "Pass since, sessionIds, or both",
    );
    ensure(
      !Number.isNaN(start) && !Number.isNaN(end) && start < end,
      "since and until must be ISO timestamps, with since before until",
    );
    ensure(
      Array.isArray(scopes) && scopes.length,
      "scopes must be a nonempty array of attribute filters",
    );
    ensure(
      sessionIds === undefined ||
        (Array.isArray(sessionIds) && sessionIds.length <= MAX_SESSIONS),
      `sessionIds must be an array of at most ${MAX_SESSIONS} IDs`,
    );
    return { since, until, start, end, scopes, sessionIds };
  }

  async function selectCandidates(selection) {
    const { scopes, sessionIds } = selection;
    const found = new Map();
    if (sessionIds) {
      for (const sessionId of sessionIds) {
        const { session } = await tau.history.read({ sessionId, limit: 1 });
        if (
          inWindow(session, selection) &&
          scopes.some((scope) => matchesScope(session, scope))
        ) {
          found.set(session.sessionId, session);
        }
      }
    } else {
      // Scopes are alternatives, and a session that matches several is kept once.
      for (const attributes of scopes) {
        let cursor;
        do {
          const page = await tau.history.search({
            attributes,
            timeRange: { field: "updatedAt", since: selection.start },
            limit: 75,
            cursor,
          });
          for (const session of page.sessions) {
            if (inWindow(session, selection)) {
              found.set(session.sessionId, session);
            }
          }
          ensure(
            found.size <= MAX_SESSIONS,
            `More than ${MAX_SESSIONS} sessions match. Narrow the time window or scopes.`,
          );
          cursor = page.nextCursor;
        } while (cursor);
      }
    }
    return [...found.values()].map(
      ({ sessionId, attributes, createdAt, updatedAt, webUrl, digest }) => ({
        sessionId,
        attributes,
        createdAt,
        updatedAt,
        webUrl,
        digest,
      }),
    );
  }

  // A session may have been active in the window if it was created before the
  // end and last updated after the start. Its transcript decides for certain.
  function inWindow(session, { start, end }) {
    return session.updatedAt >= start && session.createdAt < end;
  }

  function matchesScope(session, scope) {
    return Object.entries(scope).every(([name, filter]) => {
      const value = session.attributes[name];
      return typeof filter === "string"
        ? value === filter
        : value?.includes(filter.contains) === true;
    });
  }

  function describeSelection({ since, until, start, end, scopes, sessionIds }) {
    const parts = [];
    if (since !== undefined || until !== undefined) {
      const from =
        since === undefined ? "the beginning" : new Date(start).toISOString();
      parts.push(
        `sessions active from ${from} (inclusive) to ${new Date(end).toISOString()} (exclusive)`,
      );
    }
    if (sessionIds) parts.push(`${sessionIds.length} requested session IDs`);
    if (scopes.some((scope) => Object.keys(scope).length)) {
      parts.push(`scopes ${JSON.stringify(scopes)}`);
    }
    return parts.join(", ");
  }

  // Count candidates by source, with the Telegram project or Cowork workflow.
  function describeCandidates(candidates) {
    const counts = new Map();
    for (const { attributes } of candidates) {
      const key = [
        attributes.source ?? "no source",
        attributes.project ?? attributes.cowork_workflow,
      ]
        .filter(Boolean)
        .join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const breakdown = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} ${count}`)
      .join(", ");
    const unsummarized = candidates.filter(
      (session) => !session.digest?.summary,
    ).length;
    return `${candidates.length} sessions (${breakdown || "none"}), ${unsummarized} without a summary`;
  }

  function previewNote({ since, until }) {
    if (since === undefined && until === undefined) {
      return "Preview only. The candidates are the requested sessions that match the scopes.";
    }
    return "Preview only. Candidates are sessions created before the end of the window and last updated at or after its start, so they may have been active in it. A full run keeps only those with transcript entries inside the window, and their transcripts can also contain earlier and later entries. Missing attributes do not show that a session is outside a scope; older sessions often lack them.";
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  // Read each transcript once, and keep sessions with entries in the window.
  async function readSessions(run, candidates, { start, end }) {
    const started = Date.now();
    logStart("read", "tau.history", `${candidates.length} sessions`);
    const unreadable = [];
    const read = await inParallel(candidates, async (session) => {
      try {
        return { session, entries: await readEntries(session.sessionId) };
      } catch {
        unreadable.push(session.sessionId);
        return null;
      }
    });
    const active = read.filter((item) =>
      item?.entries.some(
        (entry) => entry.timestamp >= start && entry.timestamp < end,
      ),
    );
    if (unreadable.length) {
      run.warn(
        `${unreadable.length} sessions could not be read: ${unreadable.join(", ")}.`,
      );
    }
    run.done(
      "read",
      started,
      0,
      `active=${active.length} unreadable=${unreadable.length}`,
    );
    return active;
  }

  async function readEntries(sessionId) {
    const entries = [];
    let cursor;
    do {
      const page = await tau.history.read({ sessionId, limit: 100, cursor });
      entries.push(...page.entries.map(formatEntry));
      cursor = page.nextCursor;
    } while (cursor);
    return entries;
  }

  function formatEntry(entry) {
    const time = new Date(entry.timestamp).toISOString().slice(0, 16);
    if (entry.type === "tool") {
      const args = truncate(JSON.stringify(entry.arguments) ?? "", {
        maxChars: 256,
      });
      const result = truncate(JSON.stringify(entry.result) ?? "", {
        maxChars: 512,
      });
      return {
        id: entry.id,
        timestamp: entry.timestamp,
        text: `\n[${time} tool ${entry.name}, ${entry.outcome}, id=${entry.id}]\n${args}\n${result}\n`,
      };
    }
    const content =
      typeof entry.content === "string"
        ? entry.content
        : entry.content
            .map((part) => (part.type === "text" ? part.text : "[image]"))
            .join("\n");
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      text: `\n[${time} ${entry.type}, id=${entry.id}]\n${truncate(content, { maxChars: MAX_ENTRY_CHARS })}\n`,
    };
  }

  // ── Screening ───────────────────────────────────────────────────────────

  // Screen summaries and unsummarized tails in batches. Sessions without a
  // usable summary, and sessions in a failed batch, pass through.
  async function screen(run, sessions, { state, question }) {
    const started = Date.now();
    const screenable = [];
    const unscreened = [];
    for (const item of sessions) {
      const tail = unsummarizedTail(item);
      if (tail === null) unscreened.push(item);
      else screenable.push({ ...item, tail });
    }
    logStart(
      "screen",
      DECISION_MODEL,
      `${screenable.length} sessions, ${unscreened.length} without a usable summary`,
    );

    let cost = 0;
    let failedBatches = 0;
    const passed = await inParallel(batches(screenable), async (batch) => {
      const questions = {};
      const summaries = batch.map(({ session, tail }, index) => {
        questions[`s${index}`] = question(`s${index}`);
        return {
          id: `s${index}`,
          title: session.digest.title,
          summary: session.digest.summary,
          unsummarizedTail: tail || null,
        };
      });
      try {
        const result = await tau.models.decisions({
          model: DECISION_MODEL,
          state: { ...state, sessions: summaries },
          questions,
        });
        cost += result.usage.cost ?? 0;
        return batch.filter(
          (_, index) => result.answers[`s${index}`].noul >= SCREEN_THRESHOLD,
        );
      } catch {
        failedBatches++;
        return batch;
      }
    });
    if (failedBatches) {
      run.warn(
        `${failedBatches} screening batches failed, and their sessions went to transcript classification.`,
      );
    }

    const result = [...unscreened, ...passed.flat()];
    run.done(
      "screen",
      started,
      cost,
      `passed=${result.length}/${sessions.length} failed-batches=${failedBatches}`,
    );
    return result;
  }

  // The entries after the summary, or null when the session has no usable
  // summary or its tail is too long to screen.
  function unsummarizedTail({ session, entries }) {
    if (!session.digest?.summary) return null;
    const index = entries.findIndex(
      (entry) => entry.id === session.digest.updatedThroughEntryId,
    );
    if (index === -1) return null;
    const tail = entries
      .slice(index + 1)
      .map((entry) => entry.text)
      .join("");
    return tokens(tail) <= MAX_TAIL_TOKENS ? tail : null;
  }

  function batches(items) {
    const result = [];
    let batch = [];
    let batchTokens = 0;
    for (const item of items) {
      const size = tokens(item.session.digest.summary + item.tail);
      if (
        batch.length === MAX_SCREEN_BATCH_SESSIONS ||
        batchTokens + size > MAX_SCREEN_BATCH_TOKENS
      ) {
        result.push(batch);
        batch = [];
        batchTokens = 0;
      }
      batch.push(item);
      batchTokens += size;
    }
    if (batch.length) result.push(batch);
    return result;
  }

  // ── Classification ──────────────────────────────────────────────────────

  // Classify transcript chunks, and select a session when any chunk passes.
  async function classify(run, sessions, { state, question }) {
    const started = Date.now();
    const chunks = sessions.flatMap(({ session, entries }) =>
      split(entries).map((chunk) => ({ session, ...chunk })),
    );
    logStart(
      "classify",
      DECISION_MODEL,
      `${sessions.length} sessions, ${chunks.length} chunks`,
    );

    let cost = 0;
    const failed = new Set();
    let failedChunks = 0;
    const passed = await inParallel(chunks, async (chunk) => {
      try {
        const result = await tau.models.decisions({
          model: DECISION_MODEL,
          state: { ...state, transcript: chunk.text },
          questions: { relevant: question },
        });
        cost += result.usage.cost ?? 0;
        return result.answers.relevant.noul >= CLASSIFY_THRESHOLD;
      } catch {
        failed.add(chunk.session.sessionId);
        failedChunks++;
        return false;
      }
    });
    if (failedChunks) {
      run.warn(
        `${failedChunks} transcript chunks from ${failed.size} sessions failed classification and were excluded: ${[...failed].join(", ")}.`,
      );
    }

    const selected = new Map();
    for (const [index, chunk] of chunks.entries()) {
      if (!passed[index]) continue;
      const { session } = chunk;
      if (!selected.has(session.sessionId)) {
        selected.set(session.sessionId, {
          sessionId: session.sessionId,
          title: session.digest?.title ?? null,
          updatedAt: new Date(session.updatedAt).toISOString(),
          flaggedRanges: [],
        });
      }
      selected
        .get(session.sessionId)
        .flaggedRanges.push({ from: chunk.from, to: chunk.to });
    }

    const result = [...selected.values()];
    run.done(
      "classify",
      started,
      cost,
      [
        `selected=${result.length} failed-chunks=${failedChunks}`,
        ...result.map(
          ({ sessionId, title, updatedAt, flaggedRanges }) =>
            `- ${sessionId} (${updatedAt.slice(0, 10)}, ${flaggedRanges.length} flagged) ${title ?? "Untitled"}`,
        ),
      ].join("\n"),
    );
    return result;
  }

  // Split a transcript into chunks of whole entries.
  function split(entries) {
    const chunks = [];
    let chunk = null;
    for (const entry of entries) {
      const size = tokens(entry.text);
      if (!chunk || chunk.tokens + size > CHUNK_TOKENS) {
        chunk = { from: entry.id, to: entry.id, text: "", tokens: 0 };
        chunks.push(chunk);
      }
      chunk.to = entry.id;
      chunk.text += entry.text;
      chunk.tokens += size;
    }
    return chunks.map(({ from, to, text }) => ({ from, to, text }));
  }

  return {
    readSelection,
    selectCandidates,
    describeSelection,
    describeCandidates,
    previewNote,
    readSessions,
    screen,
    classify,
  };
})();
