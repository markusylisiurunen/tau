# Diff tool

Built-in browser-based diff review tool and reference implementation for the diff-review protocol. The session TUI launches this tool locally for `/diff`.

Keep `src/diff_tool/` as an isolated island. Diff-tool-specific prompts, HTTP handlers, review state, and browser UI code stay here. Shared contracts with Tau core should stay narrow and explicit: the diff-review protocol client plus shared protocol/types. Do not import diff-tool-only logic from `src/core/`.

## Architecture

- `index.ts` — entry point (`runBuiltInDiffToolCommand`): parses launch env vars, connects the protocol client, starts the HTTP server, opens a browser, waits for close
- `protocol_client.ts` — TCP/NDJSON client that talks to Tau's diff review protocol server over a Unix socket. Supports concurrent in-flight requests over one initialized connection, plus the server-initiated `session.close` shutdown handshake. Methods: `getContext`, `listFiles`, `getDiff`, `submitThreadMessage`, `returnReview`, `cancelSession`, `setUiText`
- `http_server.ts` — local HTTP server that serves the React app's static build and exposes the review REST API. It starts an internal bootstrap review thread eagerly, generates the reviewer guide from that context, forks later guide and comment work from the prepared threads, optionally persists review state through a client-owned opaque storage adapter, and shuts down in response to Tau's `session.close` request before the protocol client disconnects.
- `review_state_persistence.ts` — validates and versions persisted review documents, fingerprints their captured diff scope, and separates durable review transcripts from runtime-only ephemeral agent state.
- `launcher.ts` — creates a `DiffToolConfig` pointing at `node <cli> diff-tool`
- `browser.ts` — opens the URL via `open` (macOS) or `xdg-open` (Linux)
- `app/` — Vite + React TypeScript app (the browser UI)

## API endpoints

The HTTP server (`http_server.ts`) serves these endpoints, which the React app calls:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/bootstrap` | Session context, changed files, and threads |
| GET | `/api/diff[?path=<file>]` | Full diff or single-file diff patch |
| POST | `/api/state` | Patch the review draft state |
| POST | `/api/thread` | Create a local review thread |
| POST | `/api/thread/reply` | Add a pending user reply to an existing local thread |
| POST | `/api/thread/delete` | Delete a local review thread |
| POST | `/api/thread/resolve` | Mark a local review thread resolved or unresolved |
| POST | `/api/thread/collapse` | Collapse or expand a local review thread |
| POST | `/api/thread-message` | Send the pending thread messages to the review agent and store the reply |
| POST | `/api/thread-message/delete` | Delete one user or agent message from a local review thread |
| POST | `/api/guide/generate` | Start or join generation of the reviewer guide |
| POST | `/api/guide/operate` | Add or revise a guide topic, or ask a reviewer question |
| POST | `/api/guide/comment` | Save the review comment for one guide target |
| POST | `/api/review` | Return the composed review text to Tau |
| POST | `/api/cancel` | Cancel the review session |

Non-API GET requests serve static files from `app/dist/`.

## React app (`app/`)

Vite + React TypeScript single-page app. Has its own `package.json`, `tsconfig.json`, and `node_modules/`.

Key areas:
- `src/main.tsx` — React root mount and global style imports
- `src/App.tsx` — top-level composition for the shared session, Guide mode and its conversation panel, and Diff mode
- `src/features/` — feature-owned components, hooks, and styles for diff, guide, review, and thread behavior
- `src/ui/` — shared controls and content renderers
- `src/styles/` — global normalization, tokens, and text-input styling
- `src/api.ts` — fetch wrappers for each API endpoint
- `src/types.ts` — app aliases for the narrow contracts exported by `shared_types.ts`

### Install and build

```sh
cd src/diff_tool/app
npm install
npm run build    # outputs to app/dist/
```

The main project build (`npm run build` at repo root) runs the app build automatically and copies `app/dist/` into `dist/diff_tool/app/dist/`.

## Developing the React app

The app can be developed standalone without running Tau. A mock API server (`dev-server.js`) provides sample data that mimics the real diff review session.

### Quick start

Terminal 1 — mock API:
```sh
cd src/diff_tool/app
node dev-server.js
```

Terminal 2 — Vite dev server:
```sh
cd src/diff_tool/app
DIFF_TOOL_API_URL=http://127.0.0.1:9100 npm run dev
```

The Vite dev server proxies `/api` requests to the mock server. Open the URL Vite prints (usually `http://localhost:5173`).

### Mock server details

`dev-server.js` is a plain Node script (no dependencies) that serves the same API shape as the real HTTP server. It provides:
- A sample session context (repo root, cwd, diff command, conversation summary)
- Seven sample changed files (added, modified, deleted, renamed)
- A realistic multi-file unified diff patch
- Review draft state patching
- Working thread creation, replies, resolve/collapse/delete mutations, and agent message exchange (returns mock responses)
- Reviewer guide generation, topic updates, questions, and guide comments
- Review submission and cancellation (logs to stdout)

Customize the mock data by editing the constants at the top of `dev-server.js`. The `PORT` environment variable controls the listen port (default: `9100`).

### Developing against a real diff-review session

For local UI development without Tau, use the mock server above. To point Vite at a real TUI-created diff-review session:

1. Start the diff-review session from the host entrypoint
2. Note the port from the log output
3. Run Vite with the proxy pointed at that port:
   ```sh
   cd src/diff_tool/app
   DIFF_TOOL_API_URL=http://127.0.0.1:<port> npm run dev
   ```

## Developing with agent-browser

The mock API server and Vite dev server must be started by the user, not the agent. Do not attempt to run `node dev-server.js`, `npm run dev`, or `npx vite` yourself.

When the user asks to develop or test the diff tool UI using `@@skill:agent-browser`:

1. Ask the user to start the mock API server and Vite dev server if they haven't already:
   ```sh
   # terminal 1
   cd src/diff_tool/app && node dev-server.js
   # terminal 2
   cd src/diff_tool/app && DIFF_TOOL_API_URL=http://127.0.0.1:9100 npm run dev
   ```

2. Ask the user for the URL (usually `http://localhost:5173`).

3. Use agent-browser to navigate, snapshot, and interact with the running app. Make code changes to the React app as needed; Vite HMR will pick them up.

### What to verify with agent-browser

- File list renders all sample files with correct status labels
- Clicking a file loads its individual diff
- "whole diff" button loads the full session diff
- Thread creation: sending a message creates a new thread and shows the mock response
- Thread selection: clicking a thread shows its message history
- Review submission and cancellation
- Guide and Diff layouts at their supported desktop widths
