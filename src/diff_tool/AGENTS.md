# Diff tool

Built-in browser-based diff review tool for `/diff`. Launched as a child process by Tau when no external `diffTool` is configured.

Keep `src/diff_tool/` as an isolated island. Diff-tool-specific prompts, HTTP handlers, review state, and browser UI code stay here. Shared contracts with Tau core should stay narrow and explicit: the diff-review protocol client plus shared protocol/types. Do not import diff-tool-only logic from `src/core/`.

## Architecture

- `index.ts` — entry point (`runBuiltInDiffToolCommand`): parses launch env vars, connects the protocol client, starts the HTTP server, opens a browser, waits for close
- `protocol_client.ts` — TCP/NDJSON client that talks to Tau's diff review protocol server over a Unix socket. Supports concurrent in-flight requests over one initialized connection, plus the server-initiated `session.close` shutdown handshake. Methods: `getContext`, `listFiles`, `getDiff`, `submitThreadMessage`, `returnReview`, `cancelSession`, `setUiText`
- `http_server.ts` — local HTTP server that serves the React app's static build and exposes a REST API (`/api/bootstrap`, `/api/diff`, `/api/state`, `/api/thread`, `/api/thread/reply`, `/api/thread/delete`, `/api/thread/resolve`, `/api/thread/collapse`, `/api/thread-message`, `/api/brief/generate`, `/api/review`, `/api/cancel`). Starts an internal bootstrap review thread eagerly so later brief/comment threads can fork from warmed-up context, and shuts down in response to Tau's `session.close` request before the protocol client disconnects.
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
| POST | `/api/brief/generate` | Ask the review agent for a diff-wide reviewer brief |
| POST | `/api/review` | Send an optional `{ message }` and return the composed review text to Tau |
| POST | `/api/cancel` | Cancel the review session |

Non-API GET requests serve static files from `app/dist/`.

## React app (`app/`)

Vite + React TypeScript single-page app. Has its own `package.json`, `tsconfig.json`, and `node_modules/`.

Key files:
- `src/main.tsx` — React root mount
- `src/App.tsx` — main component (all UI state and layout)
- `src/App.css` — styles (dark theme, three-column grid)
- `src/api.ts` — fetch wrappers for each API endpoint
- `src/types.ts` — TypeScript types mirroring the HTTP API response shapes (intentionally duplicated from the server types since this is a separate build pipeline)

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
- Reviewer brief generation
- Review submission and cancellation (logs to stdout)

Customize the mock data by editing the constants at the top of `dev-server.js`. The `PORT` environment variable controls the listen port (default: `9100`).

### Developing against a real Tau session

To test against an actual `/diff` session:

1. Start Tau and run `/diff` (the diff tool process starts and logs its URL)
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
- Review flow: submitting with and without an optional message
- Cancel flow: clicking "cancel review"
- Responsive layout: the three-column grid collapses on narrow viewports
