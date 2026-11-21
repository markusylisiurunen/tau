// History helpers for context gathering.
//
// The workflow writes these helpers into the run folder, so the gathering
// agent's own programs can import them, and uses them itself to export the
// sessions the agent selects. They pace history requests, format
// transcripts, and run Jev in parallel on summaries, transcript chunks, or any
// texts. Errors, such as an overloaded history
// service, reach the caller unchanged.

import * as history from "@tau/history";
import { run } from "@tau/bash";
import { truncate } from "@tau/core";
import { decisions } from "@tau/models";

// History reads coincided with database overload (tau#769), so requests
// start at least this far apart, with at most this many in flight. The
// overload came from full-text search, while listing by time and reading a
// session by ID are indexed lookups, so several of those can run at once.
const PACE_MS = 200;
const MAX_IN_FLIGHT = 6;

// Jev calls go to the model service, not the history service, so they can
// run in parallel at the same width as the workflows' other model calls.
const JEV = "typesafe/jev-1.14";
const MODEL_CONCURRENCY = 8;

// Transcript chunks for Jev, in tokens at six bytes per token, as in the
// history workflows. A message is cut to at most 262,144 bytes, so a single
// entry always fits in one chunk.
const CHUNK_TOKENS = 65_536;
const MAX_ENTRY_CHARS = 65_536;

export const {
  search,
  read,
  entries,
  transcript,
  tail,
  decide,
  screen,
  classify,
} = createHelpers({ history, run, truncate, decisions });

// The module the gathering agent imports. The helpers reach the Tau packages
// only through their parameters, so their source works unchanged in a file
// of its own.
export function helperSource() {
  return `import * as history from "@tau/history";
import { run } from "@tau/bash";
import { truncate } from "@tau/core";
import { decisions } from "@tau/models";

const PACE_MS = ${PACE_MS};
const MAX_IN_FLIGHT = ${MAX_IN_FLIGHT};
const JEV = ${JSON.stringify(JEV)};
const MODEL_CONCURRENCY = ${MODEL_CONCURRENCY};
const CHUNK_TOKENS = ${CHUNK_TOKENS};
const MAX_ENTRY_CHARS = ${MAX_ENTRY_CHARS};

export const { search, read, entries, transcript, tail, decide, screen, classify } =
  (${createHelpers})({ history, run, truncate, decisions });
`;
}

function createHelpers({ history, run, truncate, decisions }) {
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

  // A session's summary and the entries after it, for screening, or null
  // when the session has no summary to start from. A summary that covers the
  // session's last entry needs no read.
  async function tail(session) {
    const digest = session.digest;
    if (!digest?.summary || !digest.updatedThroughEntryId) return null;
    if (digest.updatedThroughEntryId === session.lastEntryId) {
      return `Summary: ${digest.summary}\n\nNothing happened after the summary.`;
    }
    const after = await entries(session.sessionId, {
      afterEntryId: digest.updatedThroughEntryId,
    });
    return [
      `Summary: ${digest.summary}`,
      after.entries.length
        ? `After the summary:\n\n${after.entries.map((entry) => formatEntry(entry)).join("\n\n")}`
        : "Nothing happened after the summary.",
    ].join("\n\n");
  }

  // An entry under a heading such as `## 12 · user · <time>`, with tool
  // arguments and results shortened and images as placeholders. `maxChars`
  // also cuts the message text.
  function formatEntry(entry, number, maxChars) {
    const time = new Date(entry.timestamp).toISOString().slice(0, 19) + "Z";
    const tool = entry.type === "tool" && `${entry.name} · ${entry.outcome}`;
    const heading = [number, entry.type, tool, time]
      .filter(Boolean)
      .join(" · ");
    const body =
      entry.type === "tool"
        ? [
            truncate(JSON.stringify(entry.arguments) ?? "", { maxChars: 512 }),
            truncate(JSON.stringify(entry.result) ?? "", { maxChars: 1024 }),
          ].join("\n")
        : typeof entry.content === "string"
          ? entry.content
          : entry.content
              .map((part) => (part.type === "text" ? part.text : "[image]"))
              .join("\n");
    return `## ${heading}\n\n${maxChars ? truncate(body, { maxChars }) : body}`;
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
      MODEL_CONCURRENCY,
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

  // Screen sessions with Jev by their summary and tail, reading tails at the
  // history pace while Jev answers in parallel. Sessions without a summary
  // come back in `unscreened`, to judge by their transcript instead.
  async function screen(sessions, { questions, context = null }) {
    let cost = 0;
    const unscreened = [];
    const results = await inParallel(
      sessions,
      MODEL_CONCURRENCY,
      async (session) => {
        try {
          const text = await tail(session);
          if (text === null) {
            unscreened.push(session);
            return null;
          }
          const decided = await decide(
            [
              {
                id: session.sessionId,
                text: `${session.digest.title}\n\n${text}`,
              },
            ],
            { questions, context },
          );
          cost += decided.cost;
          const [{ answers, error }] = decided.results;
          return { session, answers, error };
        } catch (error) {
          return { session, error: String(error) };
        }
      },
    );
    return { results: results.filter(Boolean), unscreened, cost };
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

  // Split a session's entries into chunks of whole numbered entries.
  function split(all) {
    const chunks = [];
    let chunk = null;
    all.forEach((entry, index) => {
      const number = index + 1;
      const text = formatEntry(entry, number, MAX_ENTRY_CHARS);
      const size = Math.ceil(byteLength(text) / 6);
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

  // UTF-8 length, since Code Mode has no TextEncoder.
  function byteLength(text) {
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }

  return { search, read, entries, transcript, tail, decide, screen, classify };
}
