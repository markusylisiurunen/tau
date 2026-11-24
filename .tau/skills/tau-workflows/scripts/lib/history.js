// Shared selection, reading, screening, and classification for the history
// workflows.

import { docs } from "@tau/core";
import * as history from "@tau/history";
import { decisions } from "@tau/models";
import {
  bash,
  ensure,
  inParallel,
  logStart,
  tokens,
  truncateTokens,
} from "./workflow.js";

const DECISION_MODEL = "typesafe/jev-1.14";

// Limits in tokens, estimated like Tau at six bytes per token.
const MAX_TAIL_TOKENS = 8192;
const MAX_SCREEN_BATCH_TOKENS = 65_536;
const CHUNK_TOKENS = 65_536;
const MAX_ENTRY_TOKENS = 32_768;
const MAX_TOOL_ARGUMENTS_TOKENS = 64;
const MAX_TOOL_RESULT_TOKENS = 128;

// For 512 summarized candidates, one tail page, one full page, their waits,
// and one classification each use at most 2,560 calls before selection and
// batch screening. Count extra pages and chunks against the job's 4,096 calls.
// Background jobs have no time limit. Leave room for setup and the final agent.
const MAX_SESSIONS = 512;
const HISTORY_AND_MODEL_CALLS = 4096 - 64;
const MAX_SCREEN_BATCH_SESSIONS = 16;

// History reads coincided with database overload (tau#769). Limit both
// the rate of request starts and the number of requests in flight. The
// overload came from full-text search, while listing by time and reading a
// session by ID are indexed lookups, so several of those can run at once.
const HISTORY_READ_INTERVAL_MS = 200;
const HISTORY_READ_CONCURRENCY = 6;

// Jev calls go to the model service, not the history service, so more of
// them can run at once.
const JEV_CONCURRENCY = 10;

// Tells Jev what a screened session's fields are.
const SESSION_FIELDS =
  "Each session is one conversation between the user and an agent. `summary` was written automatically and covers the conversation up to a point. `unsummarizedTail` lists the conversation entries after that point, in order, or is null when the summary covers the whole conversation. Judge each session only by its own title, summary, and tail.";

// Jev probabilities. Screening keeps uncertain sessions.
const SCREEN_THRESHOLD = 0.15;
const CLASSIFY_THRESHOLD = 0.6;

// ── Selection ───────────────────────────────────────────────────────────

export function readSelection(input) {
  const { since, until, scopes = [{}], sessionIds } = input ?? {};
  const start = since === undefined ? -Infinity : Date.parse(since);
  const end = until === undefined ? Date.now() : Date.parse(until);
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

export async function selectCandidates(selection) {
  const { scopes, sessionIds } = selection;
  const found = new Map();
  if (sessionIds) {
    for (const sessionId of sessionIds) {
      const { session } = await paced(() =>
        history.read(sessionId, { limit: 1 }),
      );
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
        const page = await paced(() =>
          history.search({
            attributes,
            timeRange: {
              field: "updatedAt",
              since: selection.start,
              until: selection.end,
            },
            limit: 75,
            cursor,
          }),
        );
        for (const session of page.sessions) {
          found.set(session.sessionId, session);
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
    ({
      sessionId,
      attributes,
      createdAt,
      updatedAt,
      webUrl,
      digest,
      lastEntryId,
    }) => ({
      sessionId,
      attributes,
      createdAt,
      updatedAt,
      webUrl,
      digest,
      lastEntryId,
    }),
  );
}

function inWindow(session, { since, until, start, end }) {
  return (
    (since === undefined && until === undefined) ||
    (session.updatedAt >= start && session.updatedAt < end)
  );
}

function matchesScope(session, scope) {
  return Object.entries(scope).every(([name, filter]) => {
    const value = session.attributes[name];
    return typeof filter === "string"
      ? value === filter
      : value?.includes(filter.contains) === true;
  });
}

export function describeSelection({
  since,
  until,
  start,
  end,
  scopes,
  sessionIds,
}) {
  const parts = [];
  if (since !== undefined || until !== undefined) {
    const from =
      since === undefined ? "the beginning" : new Date(start).toISOString();
    parts.push(
      `sessions last updated from ${from} (inclusive) to ${new Date(end).toISOString()} (exclusive)`,
    );
  }
  if (sessionIds) parts.push(`${sessionIds.length} requested session IDs`);
  if (scopes.some((scope) => Object.keys(scope).length)) {
    parts.push(`scopes ${JSON.stringify(scopes)}`);
  }
  return parts.join(", ");
}

// Count candidates by source, with the Telegram project or Cowork workflow.
export function describeCandidates(candidates) {
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

export function previewNote({ since, until }) {
  if (since === undefined && until === undefined) {
    return "Preview only. The candidates are the requested sessions that match the scopes.";
  }
  return "Preview only. Candidates were last updated inside the window. Classification uses the whole transcript. Missing attributes do not show that a session is outside a scope; older sessions often lack them.";
}

// ── Reading ─────────────────────────────────────────────────────────────

let remainingCalls = HISTORY_AND_MODEL_CALLS;
class HistoryWorkflowError extends Error {}

function reserveCalls(count) {
  if (remainingCalls < count) {
    throw new HistoryWorkflowError(
      "Selection exceeds the request budget. Split the time window or session IDs and run each part separately.",
    );
  }
  remainingCalls -= count;
}

let nextStart = Promise.resolve();
let lastStart = 0;
let pages = 0;
let overload;
async function paced(request) {
  let response;
  nextStart = nextStart.then(async () => {
    if (overload) throw overload;
    const wait = lastStart + HISTORY_READ_INTERVAL_MS - Date.now();
    reserveCalls(wait > 0 ? 2 : 1);
    if (wait > 0) {
      try {
        await bash(`sleep ${wait / 1000}`);
      } catch (error) {
        throw new HistoryWorkflowError(
          `History search did not complete: could not pace requests. ${error}`,
          { cause: error },
        );
      }
    }
    if (overload) throw overload;
    lastStart = Date.now();
    pages++;
    response = request().catch((error) => {
      if (error.code === "overloaded") {
        overload ??= new HistoryWorkflowError(
          "History search did not complete: the history service is still overloaded after retries. Try again later.",
          { cause: error },
        );
        throw overload;
      }
      throw error;
    });
  });
  await nextStart;
  return response;
}

async function* readEntries(sessionId, options = {}) {
  let cursor;
  do {
    const page = await paced(() =>
      history.read(sessionId, {
        limit: 100,
        ...(cursor ? { cursor } : options),
      }),
    );
    yield page.entries;
    cursor = page.nextCursor;
  } while (cursor);
}

async function readTranscript(sessionId) {
  const entries = [];
  for await (const page of readEntries(sessionId)) {
    entries.push(...page.map(formatEntry));
  }
  return entries;
}

// The entries after a session's summary as tail entries, or null when they
// are longer than MAX_TAIL_TOKENS.
async function readTail(session) {
  const tail = [];
  let size = 0;
  for await (const page of readEntries(session.sessionId, {
    afterEntryId: session.digest.updatedThroughEntryId,
  })) {
    for (const entry of page) {
      const item = tailEntry(entry);
      size += tokens(JSON.stringify(item));
      if (size > MAX_TAIL_TOKENS) return null;
      tail.push(item);
    }
  }
  return tail;
}

export async function readSessions(run, sessions) {
  const started = Date.now();
  const before = pages;
  logStart("read", "@tau/history", `${sessions.length} sessions`);
  const results = await inParallel(
    sessions,
    async (session) => {
      try {
        return { session, entries: await readTranscript(session.sessionId) };
      } catch (error) {
        if (error instanceof HistoryWorkflowError) throw error;
        return null;
      }
    },
    HISTORY_READ_CONCURRENCY,
  );
  const unreadable = sessions.filter((_, i) => !results[i]);
  if (unreadable.length)
    run.warn(
      `${unreadable.length} sessions could not be read and were excluded: ${unreadable.map((s) => s.sessionId).join(", ")}.`,
    );
  const read = results.filter(Boolean);
  run.done(
    "read",
    started,
    0,
    `pages=${pages - before} read=${read.length} unreadable=${unreadable.length}`,
  );
  return read;
}

function formatEntry(entry) {
  const time = new Date(entry.timestamp).toISOString().slice(0, 16);
  if (entry.type === "tool") {
    return {
      id: entry.id,
      text: `\n[${time} tool ${entry.name}, ${entry.outcome}, id=${entry.id}]\n${toolArguments(entry)}\n${toolResult(entry)}\n`,
    };
  }
  return {
    id: entry.id,
    text: `\n[${time} ${entry.type}, id=${entry.id}]\n${truncateTokens(messageText(entry), MAX_ENTRY_TOKENS)}\n`,
  };
}

// A tail entry for screening, with only the fields Jev needs and the same
// cuts as transcript chunks.
function tailEntry(entry) {
  if (entry.type === "tool") {
    return {
      type: "tool",
      name: entry.name,
      outcome: entry.outcome,
      arguments: toolArguments(entry),
      result: toolResult(entry),
    };
  }
  return {
    type: entry.type,
    text: truncateTokens(messageText(entry), MAX_ENTRY_TOKENS),
  };
}

function toolArguments(entry) {
  return truncateTokens(
    JSON.stringify(entry.arguments) ?? "",
    MAX_TOOL_ARGUMENTS_TOKENS,
  );
}

function toolResult(entry) {
  return truncateTokens(
    JSON.stringify(entry.result) ?? "",
    MAX_TOOL_RESULT_TOKENS,
  );
}

// A message's text, with images as placeholders.
function messageText(entry) {
  return typeof entry.content === "string"
    ? entry.content
    : entry.content
        .map((part) => (part.type === "text" ? part.text : "[image]"))
        .join("\n");
}

// ── Screening ───────────────────────────────────────────────────────────

// Screen summaries and unsummarized tails in batches. A summary that covers
// the session's last entry has no tail to read. Sessions without a usable
// summary, and sessions in a failed batch, pass through.
export async function screen(run, sessions, { state, question }) {
  const tailStarted = Date.now();
  const before = pages;
  const anchored = sessions.filter(
    (s) => s.digest?.summary && s.digest.updatedThroughEntryId,
  ).length;
  logStart("tails", "@tau/history", `${anchored} summarized sessions`);
  if (anchored)
    ensure(
      (await docs("@tau/history")).includes("afterEntryId"),
      "Upgrade Tau before screening: @tau/history.read must support afterEntryId.",
    );
  const reads = await inParallel(
    sessions,
    async (session) => {
      if (!session.digest?.summary || !session.digest.updatedThroughEntryId)
        return { session, tail: null };
      if (session.digest.updatedThroughEntryId === session.lastEntryId)
        return { session, tail: [], current: true };
      try {
        return { session, tail: await readTail(session) };
      } catch (error) {
        if (error instanceof HistoryWorkflowError) throw error;
        return { session, tail: null, error: String(error) };
      }
    },
    HISTORY_READ_CONCURRENCY,
  );
  const failed = reads.filter((r) => r.error);
  if (failed.length)
    run.warn(
      `${failed.length} tail reads failed; those sessions will be classified in full. First failure: ${failed[0].session.sessionId}: ${failed[0].error}`,
    );
  const screenable = reads.filter((r) => r.tail !== null);
  const unscreened = reads.filter((r) => r.tail === null).map((r) => r.session);
  run.done(
    "tails",
    tailStarted,
    0,
    `pages=${pages - before} current=${reads.filter((r) => r.current).length} missing-summary-or-anchor=${sessions.length - anchored} oversized=${anchored - screenable.length - failed.length} failed=${failed.length}`,
  );

  const started = Date.now();
  logStart(
    "screen",
    DECISION_MODEL,
    `${screenable.length} sessions, ${unscreened.length} without a usable summary`,
  );

  let cost = 0;
  let failedBatches = 0;
  const groups = batches(screenable);
  reserveCalls(groups.length);
  const passed = await inParallel(
    groups,
    async (batch) => {
      const questions = {};
      const summaries = batch.map(({ session, tail }, index) => {
        questions[`s${index}`] = question(`s${index}`, session.digest.title);
        return {
          id: `s${index}`,
          title: session.digest.title,
          summary: session.digest.summary,
          unsummarizedTail: tail.length ? tail : null,
        };
      });
      try {
        const result = await decisions(
          { ...state, sessionFields: SESSION_FIELDS, sessions: summaries },
          { model: DECISION_MODEL, questions },
        );
        cost += result.usage.cost ?? 0;
        return batch.filter(
          (_, index) => result.answers[`s${index}`].noul >= SCREEN_THRESHOLD,
        );
      } catch {
        failedBatches++;
        return batch;
      }
    },
    JEV_CONCURRENCY,
  );
  if (failedBatches) {
    run.warn(
      `${failedBatches} screening batches failed, and their sessions went to transcript classification.`,
    );
  }

  const result = [...unscreened, ...passed.flat().map((item) => item.session)];
  run.done(
    "screen",
    started,
    cost,
    `passed=${result.length}/${sessions.length} failed-batches=${failedBatches}`,
  );
  return result;
}

function batches(items) {
  const result = [];
  let batch = [];
  let batchTokens = 0;
  for (const item of items) {
    const size = tokens(
      item.session.digest.summary + JSON.stringify(item.tail),
    );
    if (
      batch.length === MAX_SCREEN_BATCH_SESSIONS ||
      (batch.length && batchTokens + size > MAX_SCREEN_BATCH_TOKENS)
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
export async function classify(run, sessions, { state, question }) {
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
  reserveCalls(chunks.length);
  const passed = await inParallel(
    chunks,
    async (chunk) => {
      try {
        const result = await decisions(
          { ...state, transcript: chunk.text },
          { model: DECISION_MODEL, questions: { relevant: question } },
        );
        cost += result.usage.cost ?? 0;
        return result.answers.relevant.noul >= CLASSIFY_THRESHOLD;
      } catch {
        failed.add(chunk.session.sessionId);
        failedChunks++;
        return false;
      }
    },
    JEV_CONCURRENCY,
  );
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
