// History helpers for context gathering.
//
// The workflow writes these helpers into the run folder, so the gathering
// agent's own programs can import them, and uses them itself to export the
// sessions the agent selects. They pace history requests, format
// transcripts, run Jev in parallel on summaries, transcript chunks, or any
// texts, and find the sessions behind a change with `findSessions`. Errors,
// such as an overloaded history service, reach the caller unchanged.

import * as history from "@tau/history";
import { run } from "@tau/bash";
import { decisions } from "@tau/models";

// History reads coincided with database overload (tau#769), so requests
// start at least this far apart, with at most this many in flight. The
// overload came from full-text search, while listing by time and reading a
// session by ID are indexed lookups, so several of those can run at once.
const PACE_MS = 200;
const MAX_IN_FLIGHT = 6;

// Jev calls go to the model service, not the history service, so more of
// them can run at once.
const JEV = "typesafe/jev-1.14";
const JEV_CONCURRENCY = 10;

// Limits in tokens at six bytes per token, as in the history workflows. An
// entry is cut to fit well within one transcript chunk. A tail longer than
// its limit is classified in full instead of screened. Screening batches
// share one Jev call's state.
const CHUNK_TOKENS = 65_536;
const MAX_ENTRY_TOKENS = 32_768;
const MAX_TOOL_ARGUMENTS_TOKENS = 64;
const MAX_TOOL_RESULT_TOKENS = 128;
const MAX_TAIL_TOKENS = 8192;
const SCREEN_BATCH_SESSIONS = 16;
const SCREEN_BATCH_TOKENS = 65_536;

// Tells Jev what a screened session's fields are, as in the history
// workflows.
const SESSION_FIELDS =
  "Each session is one conversation between the user and an agent. `summary` was written automatically and covers the conversation up to a point. `unsummarizedTail` lists the conversation entries after that point, in order, or is null when the summary covers the whole conversation. Judge each session only by its own title, summary, and tail.";

// The user's own conversations. Cowork runs, Ruu, Muru, and test sessions
// are left out on purpose: they hold no decisions about development work
// that are not also in GitHub or in these sessions.
const SESSION_SCOPES = [
  { source: "tui" },
  { source: "claude-code" },
  ...[
    "alfred",
    "bob",
    "ada",
    "freya",
    "pip",
    "wren",
    "markustherobot1",
    "markustherobot2",
    "markustherobot3",
  ].map((bot) => ({ source: "telegram", telegram_bot: bot })),
];

// Candidates per call, as in the history workflows, so a call stays well
// within a job's 4,096 history and model requests.
const MAX_CANDIDATES = 512;

// Jev probabilities. Screening keeps uncertain sessions for a closer look.
const SCREEN_THRESHOLD = 0.15;
const CLASSIFY_THRESHOLD = 0.6;

// Where `findSessions` appends one JSON line of stats per call, for the
// workflow to log. The workflow's own copy of the helpers records nothing.
const STATS_PATH = null;

// Jev reads questions literally, so they say what true and false mean. A
// shared repository or topic alone must not pass, because it is the most
// common false positive. The screening question is per session in a batch,
// so it is built from the session's ID in `createHelpers`.
const CLASSIFY_QUESTIONS = {
  related: {
    type: "noul",
    instructions:
      "Does this excerpt show the user shaping the change described in the context?",
    criteria: {
      true: "It shows the user requesting or planning this change, making or confirming a decision about it, or directing its implementation.",
      false:
        "It only mentions or reports the change, concerns a different change, or does not show the user shaping it.",
    },
  },
};

export const {
  search,
  read,
  entries,
  transcript,
  tail,
  decide,
  screen,
  classify,
  findSessions,
} = createHelpers({ history, run, decisions });

// The module the gathering agent imports. The helpers reach the Tau packages
// only through their parameters, so their source works unchanged in a file
// of its own.
export function helperSource(statsPath) {
  return `import * as history from "@tau/history";
import { run } from "@tau/bash";
import { decisions } from "@tau/models";

const PACE_MS = ${PACE_MS};
const MAX_IN_FLIGHT = ${MAX_IN_FLIGHT};
const JEV = ${JSON.stringify(JEV)};
const JEV_CONCURRENCY = ${JEV_CONCURRENCY};
const CHUNK_TOKENS = ${CHUNK_TOKENS};
const MAX_ENTRY_TOKENS = ${MAX_ENTRY_TOKENS};
const MAX_TOOL_ARGUMENTS_TOKENS = ${MAX_TOOL_ARGUMENTS_TOKENS};
const MAX_TOOL_RESULT_TOKENS = ${MAX_TOOL_RESULT_TOKENS};
const MAX_TAIL_TOKENS = ${MAX_TAIL_TOKENS};
const SCREEN_BATCH_SESSIONS = ${SCREEN_BATCH_SESSIONS};
const SCREEN_BATCH_TOKENS = ${SCREEN_BATCH_TOKENS};
const SESSION_FIELDS = ${JSON.stringify(SESSION_FIELDS)};
const SESSION_SCOPES = ${JSON.stringify(SESSION_SCOPES)};
const MAX_CANDIDATES = ${MAX_CANDIDATES};
const SCREEN_THRESHOLD = ${SCREEN_THRESHOLD};
const CLASSIFY_THRESHOLD = ${CLASSIFY_THRESHOLD};
const STATS_PATH = ${JSON.stringify(statsPath)};
const CLASSIFY_QUESTIONS = ${JSON.stringify(CLASSIFY_QUESTIONS)};

export const { search, read, entries, transcript, tail, decide, screen, classify, findSessions } =
  (${createHelpers})({ history, run, decisions });
`;
}

function createHelpers({ history, run, decisions }) {
  const pace = {
    free: MAX_IN_FLIGHT,
    waiting: [],
    lastStart: 0,
    gate: Promise.resolve(),
  };

  // Wait for a free slot, then for the pace, then start the request.
  async function paced(request) {
    if (pace.free > 0) pace.free--;
    else await new Promise((resolve) => pace.waiting.push(resolve));
    try {
      const turn = pace.gate.then(async () => {
        const wait = pace.lastStart + PACE_MS - Date.now();
        if (wait > 0) await run(`sleep ${wait / 1000}`);
        pace.lastStart = Date.now();
      });
      pace.gate = turn.catch(() => {});
      await turn;
      return await request();
    } finally {
      const next = pace.waiting.shift();
      if (next) next();
      else pace.free++;
    }
  }

  // `@tau/history` search and read, paced.
  function search(options) {
    return paced(() => history.search(options));
  }

  function read(sessionId, options) {
    return paced(() => history.read(sessionId, options));
  }

  // All of a session's entries, or those after `afterEntryId`.
  async function entries(sessionId, options = {}) {
    const all = [];
    let session;
    let cursor;
    do {
      const page = await read(sessionId, {
        limit: 100,
        ...(cursor ? { cursor } : options),
      });
      session = page.session;
      all.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    return { session, entries: all };
  }

  // A session's whole transcript as compact text, with numbered entries.
  async function transcript(sessionId) {
    const result = await entries(sessionId);
    return {
      session: result.session,
      text: result.entries
        .map((entry, index) => formatEntry(entry, index + 1))
        .join("\n\n"),
    };
  }

  // A session's summary and the entries after it as
  // `{ summary, unsummarizedTail }`, for screening, where the tail is a list
  // of `tailEntry` values, or null when nothing follows the summary. Null when the session has no summary to
  // start from or the entries after it are longer than MAX_TAIL_TOKENS. A
  // summary that covers the session's last entry needs no read.
  async function tail(session) {
    const digest = session.digest;
    if (!digest?.summary || !digest.updatedThroughEntryId) return null;
    const after = [];
    let size = 0;
    let cursor;
    if (digest.updatedThroughEntryId !== session.lastEntryId) {
      do {
        const page = await read(session.sessionId, {
          limit: 100,
          ...(cursor
            ? { cursor }
            : { afterEntryId: digest.updatedThroughEntryId }),
        });
        for (const entry of page.entries) {
          const item = tailEntry(entry);
          size += tokens(JSON.stringify(item));
          if (size > MAX_TAIL_TOKENS) return null;
          after.push(item);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return {
      summary: digest.summary,
      unsummarizedTail: after.length ? after : null,
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

  // An entry under a heading such as `## 12 · user · <time>`, with tool
  // arguments and results shortened and images as placeholders. `maxTokens`
  // also cuts the message text.
  function formatEntry(entry, number, maxTokens) {
    const time = new Date(entry.timestamp).toISOString().slice(0, 19) + "Z";
    const tool = entry.type === "tool" && `${entry.name} · ${entry.outcome}`;
    const heading = [number, entry.type, tool, time]
      .filter(Boolean)
      .join(" · ");
    const body =
      entry.type === "tool"
        ? `${toolArguments(entry)}\n${toolResult(entry)}`
        : messageText(entry);
    return `## ${heading}\n\n${maxTokens ? truncateTokens(body, maxTokens) : body}`;
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

  // Run fn over items with at most `width` calls in flight, keeping order.
  async function inParallel(items, width, fn) {
    const results = [];
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(width, items.length) }, worker),
    );
    return results;
  }

  // Ask Jev the same questions about many texts in parallel. Each item is
  // `{ id, text }`, and `context` is shared state, such as a description of
  // the change. Jev bills the state once per call, so several questions cost
  // little more than one. Returns `{ id, answers }` or `{ id, error }` per
  // item, in order, and the total cost.
  async function decide(items, { questions, context = null }) {
    let cost = 0;
    const results = await inParallel(
      items,
      JEV_CONCURRENCY,
      async ({ id, text }) => {
        try {
          const result = await decisions(
            { context, text },
            { model: JEV, questions },
          );
          cost += result.usage.cost ?? 0;
          return { id, answers: result.answers };
        } catch (error) {
          return { id, error: String(error) };
        }
      },
    );
    return { results, cost };
  }

  // Screen sessions with Jev by their summary and tail, in batches of up to
  // SCREEN_BATCH_SESSIONS sessions and SCREEN_BATCH_TOKENS tokens that share
  // one call's state. Tails are read at the history pace. Sessions without a
  // summary, or with a tail longer than MAX_TAIL_TOKENS, come back in
  // `unscreened`, to judge by their transcript instead. `question(id, title)`
  // gives the question about the session with that ID and title in its batch. Returns
  // `{ session, answer }` or `{ session, error }` per screened session.
  async function screen(sessions, { question, context = null }) {
    const unscreened = [];
    const results = [];
    const tails = await inParallel(sessions, MAX_IN_FLIGHT, async (session) => {
      try {
        const found = await tail(session);
        if (found) return { session, ...found };
        unscreened.push(session);
      } catch (error) {
        results.push({ session, error: String(error) });
      }
      return null;
    });
    let cost = 0;
    await inParallel(
      screenBatches(tails.filter(Boolean)),
      JEV_CONCURRENCY,
      async (batch) => {
        const questions = {};
        const items = batch.map(
          ({ session, summary, unsummarizedTail }, index) => {
            questions[`s${index}`] = question(
              `s${index}`,
              session.digest.title,
            );
            return {
              id: `s${index}`,
              title: session.digest.title,
              summary,
              unsummarizedTail,
            };
          },
        );
        try {
          const result = await decisions(
            { context, sessionFields: SESSION_FIELDS, sessions: items },
            { model: JEV, questions },
          );
          cost += result.usage.cost ?? 0;
          batch.forEach(({ session }, index) =>
            results.push({ session, answer: result.answers[`s${index}`] }),
          );
        } catch (error) {
          for (const { session } of batch) {
            results.push({ session, error: String(error) });
          }
        }
      },
    );
    return { results, unscreened, cost };
  }

  function screenBatches(items) {
    const batches = [];
    let batch = [];
    let batchTokens = 0;
    for (const item of items) {
      const size = tokens(item.summary + JSON.stringify(item.unsummarizedTail));
      if (
        batch.length === SCREEN_BATCH_SESSIONS ||
        (batch.length && batchTokens + size > SCREEN_BATCH_TOKENS)
      ) {
        batches.push(batch);
        batch = [];
        batchTokens = 0;
      }
      batch.push(item);
      batchTokens += size;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function screenQuestion(id, title) {
    return {
      type: "noul",
      instructions: `Does the summary or tail of session ${id} (${JSON.stringify(title)}) indicate that the session may have shaped the change described in the context?`,
      criteria: {
        true: "It describes a request, discussion, decision, or implementation that could concern this change, even if it leaves the connection or the user's role unclear.",
        false:
          "It gives no concrete indication of this change, only mentions it in passing, or describes other work that shares its topic, repository, or identifiers.",
      },
    };
  }

  // Ask Jev the same questions about every chunk of each session's
  // transcript. Sessions are read at the history pace, and all chunks then go
  // to `decide` together. A chunk holds whole entries, numbered as in
  // `transcript`. Returns `{ sessionId, chunks }` per session, in order, where
  // each chunk is `{ from, to, answers }` or `{ from, to, error }`, or
  // `{ sessionId, error }` when the session could not be read, and the total
  // cost.
  async function classify(sessions, { questions, context = null }) {
    const read = await inParallel(sessions, MAX_IN_FLIGHT, async (session) => {
      try {
        const result = await entries(session.sessionId);
        return { sessionId: session.sessionId, chunks: split(result.entries) };
      } catch (error) {
        return { sessionId: session.sessionId, error: String(error) };
      }
    });
    const items = read.flatMap(({ sessionId, chunks = [] }) =>
      chunks.map((chunk, index) => ({
        id: `${sessionId}:${index}`,
        text: chunk.text,
      })),
    );
    const decided = await decide(items, { questions, context });
    let next = 0;
    const results = read.map(({ sessionId, chunks, error }) => {
      if (error) return { sessionId, error };
      return {
        sessionId,
        chunks: chunks.map(({ from, to }) => {
          const { answers, error } = decided.results[next++];
          return error ? { from, to, error } : { from, to, answers };
        }),
      };
    });
    return { results, cost: decided.cost };
  }

  // Find the sessions where the user shaped a change. Lists the user's
  // sessions active in the window, screens them by summary and tail, and
  // classifies the transcripts of those that pass and of those without a
  // summary. Returns the matching sessions, highest score first, each
  // with its title, attributes, when it was created and last updated, and its
  // highest classification score.
  // Also returns the sessions it could not assess, with the reason.
  async function findSessions(options) {
    const start = toTime(options.since, "since");
    const end = toTime(options.until, "until");
    if (start >= end) throw new Error("since must be before until");
    if (typeof options.change !== "string" || !options.change.trim()) {
      throw new Error("change must describe the change");
    }
    const stats = {
      startedAt: Date.now(),
      since: new Date(start).toISOString(),
      until: new Date(end).toISOString(),
      cost: 0,
    };
    try {
      return await searchSessions(options, start, end, stats);
    } catch (error) {
      stats.error = String(error);
      throw error;
    } finally {
      await recordStats(stats);
    }
  }

  // The steps of `findSessions`, counting what each step keeps in `stats`.
  async function searchSessions(
    { change, repository, pullRequest, issues = [], branch },
    start,
    end,
    stats,
  ) {
    const context = changeContext({
      change,
      repository,
      pullRequest,
      issues,
      branch,
    });

    // `updatedAt` finds sessions still active at the start, and a session
    // created after the end did not lead to the change.
    const candidates = new Map();
    for (const attributes of SESSION_SCOPES) {
      let cursor;
      do {
        const page = await search({
          attributes,
          timeRange: { field: "updatedAt", since: start },
          limit: 75,
          cursor,
        });
        for (const session of page.sessions) {
          if (session.createdAt < end) {
            candidates.set(session.sessionId, session);
          }
        }
        if (candidates.size > MAX_CANDIDATES) {
          throw new Error(
            `More than ${MAX_CANDIDATES} sessions are active in the window. Narrow it.`,
          );
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    stats.candidates = candidates.size;
    stats.bySource = {};
    for (const { attributes } of candidates.values()) {
      const source = attributes.telegram_bot
        ? `telegram/${attributes.telegram_bot}`
        : attributes.source;
      stats.bySource[source] = (stats.bySource[source] ?? 0) + 1;
    }

    const unassessed = [];
    const screened = await screen([...candidates.values()], {
      question: screenQuestion,
      context,
    });
    stats.cost += screened.cost;
    const noSummary = screened.unscreened.filter(
      (session) =>
        !session.digest?.summary || !session.digest.updatedThroughEntryId,
    ).length;
    stats.screened = screened.results.length;
    stats.noSummary = noSummary;
    stats.longTail = screened.unscreened.length - noSummary;
    stats.screenErrors = screened.results.filter(({ error }) => error).length;

    // A session without a summary has nothing to screen, so its whole
    // transcript is classified.
    const passed = [...screened.unscreened];
    for (const { session, answer, error } of screened.results) {
      if (error) unassessed.push(gap(session, `screening failed: ${error}`));
      else if (answer.noul >= SCREEN_THRESHOLD) passed.push(session);
    }
    stats.passedScreening = passed.length - screened.unscreened.length;

    // Batch whole-transcript reads so only a few transcripts are held at once.
    const results = [];
    for (let i = 0; i < passed.length; i += JEV_CONCURRENCY) {
      const batch = passed.slice(i, i + JEV_CONCURRENCY);
      const classified = await classify(batch, {
        questions: CLASSIFY_QUESTIONS,
        context,
      });
      stats.cost += classified.cost;
      results.push(...classified.results);
    }
    stats.classified = results.length;
    stats.chunks = results.reduce(
      (count, { chunks = [] }) => count + chunks.length,
      0,
    );
    const sessions = [];
    for (const { sessionId, chunks, error } of results) {
      const session = candidates.get(sessionId);
      if (error) {
        unassessed.push(gap(session, `reading failed: ${error}`));
        continue;
      }
      const failed = chunks.filter((chunk) => chunk.error);
      if (failed.length) {
        unassessed.push(
          gap(
            session,
            `classifying entries ${failed.map(({ from, to }) => `${from}–${to}`).join(", ")} failed: ${failed[0].error}`,
          ),
        );
      }
      const flagged = chunks.filter(
        (chunk) => chunk.answers?.related.noul >= CLASSIFY_THRESHOLD,
      );
      if (flagged.length) {
        sessions.push({
          sessionId,
          title: session.digest?.title ?? "untitled",
          attributes: session.attributes,
          createdAt: new Date(session.createdAt).toISOString(),
          updatedAt: new Date(session.updatedAt).toISOString(),
          score: Math.max(
            ...flagged.map((chunk) => chunk.answers.related.noul),
          ),
        });
      }
    }
    sessions.sort((a, b) => b.score - a.score);
    stats.matched = sessions.length;
    stats.unassessed = unassessed.length;
    return { sessions, unassessed };
  }

  // Append a call's stats for the workflow's log. Writing them must not fail
  // the search, so a failed write only loses the line.
  async function recordStats(stats) {
    if (!STATS_PATH) return;
    try {
      await run(`cat >> '${STATS_PATH}'`, {
        stdin: `${JSON.stringify({ ...stats, endedAt: Date.now() })}\n`,
      });
    } catch {}
  }

  // The context Jev judges sessions against: the agent's description of the
  // change, and identifiers that only count as a lead together with it.
  function changeContext({ change, repository, pullRequest, issues, branch }) {
    const identifiers = [
      repository && `- Repository: ${repository}`,
      pullRequest && `- Pull request: #${pullRequest}`,
      issues.length &&
        `- Issues: ${issues.map((issue) => (typeof issue === "number" ? `#${issue}` : issue)).join(", ")}`,
      branch && `- Branch: ${branch}`,
    ].filter(Boolean);
    return [
      `The change:\n\n${change.trim()}`,
      identifiers.length &&
        `Identifiers that sessions about this change may mention. Sharing only the repository does not make a session about this change.\n\n${identifiers.join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function gap(session, reason) {
    return {
      sessionId: session.sessionId,
      title: session.digest?.title ?? "untitled",
      reason,
    };
  }

  function toTime(value, name) {
    const time = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(time)) {
      throw new Error(`${name} must be an ISO timestamp or epoch milliseconds`);
    }
    return time;
  }

  // Split a session's entries into chunks of whole numbered entries.
  function split(all) {
    const chunks = [];
    let chunk = null;
    all.forEach((entry, index) => {
      const number = index + 1;
      const text = formatEntry(entry, number, MAX_ENTRY_TOKENS);
      const size = tokens(text);
      if (!chunk || chunk.tokens + size > CHUNK_TOKENS) {
        chunk = { from: number, to: number, text: "", tokens: 0 };
        chunks.push(chunk);
      } else {
        chunk.text += "\n\n";
      }
      chunk.to = number;
      chunk.text += text;
      chunk.tokens += size;
    });
    return chunks;
  }

  // Tokens at six bytes per token, counting UTF-8 bytes by hand, since Code
  // Mode has no TextEncoder.
  function tokens(text) {
    let bytes = 0;
    for (const char of text) bytes += charBytes(char);
    return Math.ceil(bytes / 6);
  }

  // Cut text to at most `maxTokens` tokens, marking the cut.
  function truncateTokens(text, maxTokens) {
    const maxBytes = maxTokens * 6;
    let bytes = 0;
    let end = 0;
    for (const char of text) {
      bytes += charBytes(char);
      if (bytes > maxBytes) return `${text.slice(0, end)} [cut]`;
      end += char.length;
    }
    return text;
  }

  function charBytes(char) {
    const code = char.codePointAt(0);
    return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }

  return {
    search,
    read,
    entries,
    transcript,
    tail,
    decide,
    screen,
    classify,
    findSessions,
  };
}
