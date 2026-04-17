/**
 * Mock API server for developing the diff tool React app without running Tau.
 *
 * Usage:
 *   node dev-server.js              # starts on port 9100
 *   PORT=9200 node dev-server.js    # custom port
 *
 * Then in another terminal:
 *   DIFF_TOOL_API_URL=http://127.0.0.1:9100 npm run dev
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT) || 9100;

// --- sample data ---

const context = {
  sessionId: "dev-session-001",
  repoRoot: "/Users/dev/projects/example-app",
  cwd: "/Users/dev/projects/example-app",
  diffArgs: [],
  diffCommand: "current working tree",
};

const files = [
  { path: "src/auth/login.ts", status: "modified" },
  { path: "src/auth/middleware.ts", status: "modified" },
  { path: "src/auth/jwt.ts", status: "added" },
  { path: "src/auth/session.ts", status: "deleted" },
  { path: "src/auth/types.ts", status: "modified" },
  {
    path: "src/features/account/security/audit-log/components/audit-log-row.tsx",
    status: "modified",
  },
  { path: "README.md", status: "modified" },
  {
    path: "src/routes/index.ts",
    status: "modified",
    oldPath: "src/routes/main.ts",
    newPath: "src/routes/index.ts",
  },
];

const sessionPatch = [
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "index abc1234..def5678 100644",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -1,8 +1,9 @@",
  '-import { createSession } from "./session";',
  '+import { signToken } from "./jwt";',
  ' import { hashPassword, verifyPassword } from "./crypto";',
  '+import type { AuthToken } from "./types";',
  " ",
  " export async function login(email: string, password: string) {",
  "   const user = await findUserByEmail(email);",
  "   if (!user || !verifyPassword(password, user.passwordHash)) {",
  '     throw new AuthError("invalid credentials");',
  "   }",
  "-  return createSession(user.id);",
  "+  const token: AuthToken = await signToken({ sub: user.id, email: user.email });",
  "+  return { token, expiresIn: 3600 };",
  " }",
  "diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/auth/middleware.ts",
  "+++ b/src/auth/middleware.ts",
  "@@ -1,7 +1,8 @@",
  '-import { getSession } from "./session";',
  '+import { verifyToken } from "./jwt";',
  " ",
  " export function authMiddleware(req, res, next) {",
  "-  const sessionId = req.cookies?.sessionId;",
  "-  if (!sessionId || !getSession(sessionId)) {",
  "+  const header = req.headers.authorization;",
  '+  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;',
  "+  if (!token || !verifyToken(token)) {",
  '     return res.status(401).json({ error: "unauthorized" });',
  "   }",
  "   next();",
  " }",
  "diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts",
  "new file mode 100644",
  "index 0000000..abcdef1",
  "--- /dev/null",
  "+++ b/src/auth/jwt.ts",
  "@@ -0,0 +1,12 @@",
  '+import { sign, verify } from "jsonwebtoken";',
  "+",
  "+const SECRET = process.env.JWT_SECRET!;",
  "+",
  "+export function signToken(payload: Record<string, unknown>): string {",
  '+  return sign(payload, SECRET, { expiresIn: "1h" });',
  "+}",
  "+",
  "+export function verifyToken(token: string): Record<string, unknown> | null {",
  "+  try {",
  "+    return verify(token, SECRET) as Record<string, unknown>;",
  "+  } catch {",
  "+    return null;",
  "+  }",
  "+}",
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "deleted file mode 100644",
  "index fedcba9..0000000",
  "--- a/src/auth/session.ts",
  "+++ /dev/null",
  "@@ -1,11 +0,0 @@",
  "-const sessions = new Map<string, { userId: string; createdAt: number }>();",
  "-",
  "-export function createSession(userId: string): string {",
  "-  const id = crypto.randomUUID();",
  "-  sessions.set(id, { userId, createdAt: Date.now() });",
  "-  return id;",
  "-}",
  "-",
  "-export function getSession(id: string) {",
  "-  return sessions.get(id) ?? null;",
  "-}",
  "diff --git a/src/auth/types.ts b/src/auth/types.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth/types.ts",
  "+++ b/src/auth/types.ts",
  "@@ -1,3 +1,8 @@",
  " export type User = {",
  "   id: string;",
  "+  email: string;",
  "   passwordHash: string;",
  " };",
  "+",
  "+export type AuthToken = {",
  "+  token: string;",
  "+  expiresIn: number;",
  "+};",
  "diff --git a/src/features/account/security/audit-log/components/audit-log-row.tsx b/src/features/account/security/audit-log/components/audit-log-row.tsx",
  "index 7a7a7a7..8b8b8b8 100644",
  "--- a/src/features/account/security/audit-log/components/audit-log-row.tsx",
  "+++ b/src/features/account/security/audit-log/components/audit-log-row.tsx",
  "@@ -18,11 +18,15 @@ export function AuditLogRow({ entry }: AuditLogRowProps) {",
  "   return (",
  '     <div className="audit-log-row">',
  '       <span className="audit-log-action">{entry.action}</span>',
  '-      <span className="audit-log-meta">{entry.actorName}</span>',
  '+      <span className="audit-log-meta">',
  "+        {entry.actorName} · {formatRelativeTime(entry.createdAt)}",
  "+      </span>",
  "       {entry.ipAddress && (",
  '         <span className="audit-log-ip">{entry.ipAddress}</span>',
  "       )}",
  "+      {entry.location && (",
  '+        <span className="audit-log-location">{entry.location}</span>',
  "+      )}",
  "     </div>",
  "   );",
  " }",
  "diff --git a/src/routes/main.ts b/src/routes/index.ts",
  "similarity index 88%",
  "rename from src/routes/main.ts",
  "rename to src/routes/index.ts",
  "index 3333333..4444444 100644",
  "--- a/src/routes/main.ts",
  "+++ b/src/routes/index.ts",
  "@@ -1,4 +1,4 @@",
  ' import { createRouter } from "./router";',
  " ",
  "-export const mainRouter = createRouter();",
  "+export const indexRouter = createRouter();",
  " ",
  " export default indexRouter;",
].join("\n");

const filePatchMap = new Map();
for (const chunk of sessionPatch.split(/(?=^diff --git )/m)) {
  const trimmed = chunk.trim();
  if (!trimmed) continue;
  const pathMatch = trimmed.match(/^diff --git a\/\S+ b\/(\S+)/);
  if (pathMatch) {
    filePatchMap.set(pathMatch[1], trimmed);
  }
}

const mockThreads = [
  {
    id: "thread-dev-001",
    anchor: {
      kind: "line",
      fileId: "dev-session-001-0-0",
      filePath: "src/auth/login.ts",
      lineNumber: 9,
      side: "additions",
    },
    messages: [
      {
        role: "user",
        text: "Should we avoid returning `expiresIn` as a bare number and use a named constant instead?",
      },
    ],
    loading: false,
    resolved: false,
    collapsed: false,
  },
  {
    id: "thread-dev-002",
    threadId: "thread-mock-002",
    anchor: {
      kind: "line",
      fileId: "dev-session-001-0-1",
      filePath: "src/auth/middleware.ts",
      lineNumber: 6,
      side: "additions",
    },
    messages: [
      {
        role: "user",
        text: [
          "I think the `Authorization` parsing is moving in the right direction, but I want to sanity-check a few details:",
          "",
          "- do we want to accept lowercase `bearer` too?",
          "- should we split token extraction from validation?",
          "- can `verifyToken()` throw for malformed input, or is the null fallback enough?",
        ].join("\n"),
      },
      {
        role: "assistant",
        text: [
          "A few thoughts:",
          "",
          "1. **Case sensitivity**: RFC 6750 examples use `Bearer`, but many servers accept case-insensitive schemes. If the rest of the stack does not care, allowing both can reduce surprises.",
          "2. **Separation of concerns**: extracting the token in a tiny helper would make this middleware easier to scan and easier to unit test.",
          "3. **Malformed input**: given the current `verifyToken()` implementation, returning `null` is probably enough for now.",
          "",
          "> I would keep the middleware strict unless we already know clients send inconsistent casing.",
        ].join("\n"),
      },
      {
        role: "user",
        text: [
          "Makes sense. I also worry that we silently lose context when auth fails.",
          "",
          "Could we keep the external response as `401`, but still make the code path a bit clearer? Maybe something like:",
          "",
          "```ts",
          "const token = readBearerToken(req.headers.authorization);",
          'if (!token) return res.status(401).json({ error: "unauthorized" });',
          "",
          "const claims = verifyToken(token);",
          'if (!claims) return res.status(401).json({ error: "unauthorized" });',
          "```",
        ].join("\n"),
      },
      {
        role: "assistant",
        text: [
          "Yes, that reads better.",
          "",
          "It gives you:",
          "",
          "- a clear parsing step",
          "- a clear verification step",
          "- an obvious place to add logging later without changing the response contract",
          "",
          "I would probably also name the verified value `auth` or `session` only if downstream code actually uses it. Otherwise `claims` is accurate and keeps the JWT boundary explicit.",
        ].join("\n"),
      },
    ],
    loading: false,
    resolved: true,
    collapsed: true,
  },
];

const state = {
  diffStyle: "split",
  overflowMode: "wrap",
  sidebarOpen: false,
  sidebarWidth: "narrow",
  collapsedFileIds: [],
  viewedFileIds: ["dev-session-001-0-0"],
  threads: mockThreads,
  brief: {
    content: "",
    loading: false,
  },
};

// --- server ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : {});
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, null);
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(res, 200, {
        context,
        files,
        state,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/diff") {
      const path = url.searchParams.get("path")?.trim() || undefined;
      if (path) {
        const patch = filePatchMap.get(path) ?? "(no diff for this file)";
        sendJson(res, 200, { scope: "file", path, patch });
      } else {
        sendJson(res, 200, { scope: "session", patch: sessionPatch });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      const body = await readBody(req);
      if (body.diffStyle === "split" || body.diffStyle === "stacked") {
        state.diffStyle = body.diffStyle;
      }
      if (body.overflowMode === "wrap" || body.overflowMode === "scroll") {
        state.overflowMode = body.overflowMode;
      }
      if (typeof body.sidebarOpen === "boolean") {
        state.sidebarOpen = body.sidebarOpen;
      }
      if (body.sidebarWidth === "narrow" || body.sidebarWidth === "wide") {
        state.sidebarWidth = body.sidebarWidth;
      }
      if (Array.isArray(body.collapsedFileIds)) {
        state.collapsedFileIds = body.collapsedFileIds.filter(
          (value) => typeof value === "string",
        );
      }
      if (Array.isArray(body.viewedFileIds)) {
        state.viewedFileIds = body.viewedFileIds.filter(
          (value) => typeof value === "string",
        );
      }
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread") {
      const body = await readBody(req);
      const message = typeof body.body === "string" ? body.body.trim() : "";
      if (!message) {
        sendJson(res, 400, { error: "body is required" });
        return;
      }

      state.threads.push({
        id: randomUUID(),
        anchor: body.anchor,
        messages: [{ role: "user", text: message }],
        loading: false,
        resolved: false,
        collapsed: false,
      });
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/reply") {
      const body = await readBody(req);
      const thread = state.threads.find((entry) => entry.id === body.id);
      if (!thread) {
        sendJson(res, 404, { error: "thread not found" });
        return;
      }

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "text is required" });
        return;
      }

      thread.messages.push({ role: "user", text });
      thread.resolved = false;
      thread.collapsed = false;
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/delete") {
      const body = await readBody(req);
      const index = state.threads.findIndex((entry) => entry.id === body.id);
      if (index < 0) {
        sendJson(res, 404, { error: "thread not found" });
        return;
      }

      state.threads.splice(index, 1);
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/resolve") {
      const body = await readBody(req);
      const thread = state.threads.find((entry) => entry.id === body.id);
      if (!thread) {
        sendJson(res, 404, { error: "thread not found" });
        return;
      }
      if (typeof body.resolved !== "boolean") {
        sendJson(res, 400, { error: "resolved flag is required" });
        return;
      }

      thread.resolved = body.resolved;
      thread.collapsed = body.resolved;
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/collapse") {
      const body = await readBody(req);
      const thread = state.threads.find((entry) => entry.id === body.id);
      if (!thread) {
        sendJson(res, 404, { error: "thread not found" });
        return;
      }
      if (typeof body.collapsed !== "boolean") {
        sendJson(res, 400, { error: "collapsed flag is required" });
        return;
      }

      thread.collapsed = body.collapsed;
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread-message") {
      const body = await readBody(req);
      const thread = state.threads.find((entry) => entry.id === body.id);
      if (!thread) {
        sendJson(res, 404, { error: "thread not found" });
        return;
      }

      const pendingMessages = [];
      for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
        const message = thread.messages[index];
        if (message.role === "assistant") {
          break;
        }
        pendingMessages.unshift(message.text);
      }
      const pendingText = pendingMessages.join("\n\n");
      if (!pendingText) {
        sendJson(res, 400, { error: "thread has no pending user message" });
        return;
      }

      thread.loading = true;
      const threadId = thread.threadId || `thread-${randomUUID().slice(0, 8)}`;
      const locationPrefix =
        thread.threadId || thread.anchor.kind !== "line"
          ? ""
          : `[${thread.anchor.filePath}:${thread.anchor.lineNumber} (${thread.anchor.side === "additions" ? "new" : "old"})]\n\n`;
      const message = `${locationPrefix}${pendingText}`;
      const response = `[mock response] You asked: "${message}"\n\nThis is a simulated review thread response. The real Tau diff review would run an AI model to answer questions about the diff.`;
      thread.threadId = threadId;
      thread.messages.push({ role: "assistant", text: response });
      thread.loading = false;
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/brief/generate") {
      state.brief.loading = true;
      state.brief = {
        threadId: `brief-${randomUUID().slice(0, 8)}`,
        loading: false,
        content: [
          "## Summary",
          "",
          "Replaces cookie-based sessions with JWT bearer tokens. The change touches login, request middleware, types, and removes the in-memory session store entirely. Risk is in the auth contract shift and deployment assumptions, not the route rename (safe to skim).",
          "",
          "## Behavior changes",
          "",
          "Login now returns a token instead of setting a cookie:",
          "",
          "```",
          "// before: res.cookie('sid', sessionId)",
          "// after:",
          "return { token: jwt.sign(payload, secret), expiresIn: 3600 }",
          "```",
          "",
          "Requests without `Authorization: Bearer <token>` now fail with 401. Previously a valid `sessionId` cookie was enough, so this is a client-facing contract break.",
          "",
          "Deleting `session.ts` also removes server-side revocation. Tokens are now valid until expiry — there is no way to force-logout a user.",
          "",
          "## Verify",
          "",
          "- Existing cookie clients will break — intentional for this release?",
          "- Secret rotation and forced revocation are out of scope — confirmed?",
          "- Auth failures return a bare 401 with no logging — acceptable?",
          "- Are malformed/expired token paths tested end-to-end?",
        ].join("\n"),
      };
      sendJson(res, 200, { state });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/review") {
      const unresolvedThreads = state.threads.filter(
        (thread) => !thread.resolved,
      );
      const review = unresolvedThreads.length
        ? unresolvedThreads
            .map((thread, index) => {
              const location =
                thread.anchor.kind === "line"
                  ? `${thread.anchor.filePath}:${thread.anchor.lineNumber} (${thread.anchor.side === "additions" ? "new" : "old"})`
                  : "general discussion";
              const body = thread.messages
                .map(
                  (message) =>
                    `**${message.role === "assistant" ? "agent" : "user"}**\n\n${message.text}`,
                )
                .join("\n\n");
              return `## thread ${index + 1}\n\n\`${location}\`\n\n${body}`;
            })
            .join("\n\n---\n\n")
        : "(no comments)";
      console.log(`\nreview returned:\n${review}\n`);
      sendJson(res, 200, { status: "returned" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel") {
      console.log("\nreview cancelled\n");
      sendJson(res, 200, { status: "cancelled" });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message ?? String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `mock diff tool api server listening at http://127.0.0.1:${PORT}`,
  );
  console.log("start vite in another terminal:");
  console.log(`  DIFF_TOOL_API_URL=http://127.0.0.1:${PORT} npm run dev`);
});
