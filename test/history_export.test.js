import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { runHistoryReadCommand } from "../dist/core/history/cli.js";
import {
  historyExportSchema,
  readHistoryExport,
  renderHistoryMarkdown,
} from "../dist/core/history/export.js";
import {
  getDefaultHistoryDatabasePath,
  LocalHistoryStore,
} from "../dist/core/history/local_history_store.js";
import { BYTES_PER_TOKEN } from "../dist/core/utils/token.js";

const session = {
  sessionId: "parent",
  attributes: { source: "cli" },
  createdAt: 1,
  updatedAt: 2,
  childCount: 0,
  snippets: [],
};
const entry = (id) => ({ id, sourceIds: [id], timestamp: 1, type: "user", content: "hello" });

describe("history export", () => {
  it("flushes a large CLI export to a pipe and leaves stdout empty on read failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-history-export-"));
    try {
      const store = new LocalHistoryStore(getDefaultHistoryDatabasePath(home));
      const entries = [{ ...entry("large"), content: "payload\n".repeat(50000) }];
      try {
        store.createSession(session);
        store.append("parent", entries);
      } finally {
        store.close();
      }
      const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const options = {
        cwd: home,
        env: { ...process.env, HOME: home, TAU_OFFLINE: "1" },
        maxBuffer: 2 * 1024 * 1024,
      };
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [cli, "history", "read", "parent"],
        options,
      );
      expect(JSON.parse(stdout).entries).toEqual(entries);
      await expect(
        promisify(execFile)(process.execPath, [cli, "history", "read", "missing"], options),
      ).rejects.toMatchObject({ code: 1, stdout: "" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exports all local entries and children across real store pages", async () => {
    const store = new LocalHistoryStore(":memory:");
    try {
      store.createSession(session);
      const entries = Array.from({ length: 205 }, (_, index) => entry(`entry-${index}`));
      store.append("parent", entries);
      for (let index = 0; index < 105; index++) {
        store.createSession({ ...session, sessionId: `child-${index}`, parentSessionId: "parent" });
      }
      store.createSession({ ...session, sessionId: "grandchild", parentSessionId: "child-0" });
      const data = await readHistoryExport(store, "parent");
      expect(data.entries).toEqual(entries);
      expect(data.session.childSessionIds).toHaveLength(105);
      expect(new Set(data.session.childSessionIds).size).toBe(105);
      expect(data.session.childSessionIds).not.toContain("grandchild");
    } finally {
      store.close();
    }
  });

  it("exhausts transcript and direct-child pages from the same query", async () => {
    const query = {
      read: vi.fn(async ({ cursor }) => ({
        session,
        entries: [entry(cursor ? "second" : "first")],
        ...(cursor ? {} : { nextCursor: "entries-page-2" }),
      })),
      search: vi.fn(async ({ cursor, limit }) => {
        if (limit > 75) throw new Error("invalid search limit");
        return {
          sessions: [{ ...session, sessionId: cursor ? "child-b" : "child-a" }],
          ...(cursor ? {} : { nextCursor: "children-page-2" }),
        };
      }),
    };
    const data = await readHistoryExport(query, "parent");
    expect(data.entries.map((e) => e.id)).toEqual(["first", "second"]);
    expect(data.session.childSessionIds).toEqual(["child-a", "child-b"]);
    expect(data.session.childCount).toBe(2);
    expect(query.read.mock.calls[1][0].cursor).toBe("entries-page-2");
    expect(query.search.mock.calls[1][0]).toMatchObject({
      parent: { sessionId: "parent" },
      cursor: "children-page-2",
    });
    expect(historyExportSchema.parse(data)).toEqual(data);
  });

  it("prints an offline JSON schema without opening history", async () => {
    const stdout = vi.fn();
    await runHistoryReadCommand(["--schema"], { stdout });
    expect(JSON.parse(stdout.mock.calls[0][0])).toBeTypeOf("object");
  });

  it("fences embedded structure, preserves text and image positions, and budgets whole tool fields", () => {
    const content = "before\n```\n## forged entry\n````\nafter";
    const image = { type: "image", mimeType: "image/png", data: "SECRET_BASE64" };
    const data = {
      session: {
        ...session,
        attributes: { source: "cli", project: "---\n## injected" },
        childSessionIds: [],
      },
      entries: [
        {
          ...entry("user"),
          content: [{ type: "text", text: content }, image, { type: "text", text: "last" }],
        },
        {
          id: "tool",
          sourceIds: ["tool"],
          timestamp: 2,
          type: "tool",
          name: "read",
          outcome: "failed",
          arguments: {
            text: "😀".repeat(3000),
            metadata: {
              type: "image",
              mimeType: "image/png",
              url: "https://example.com/image",
              caption: "preserved caption",
            },
          },
          result: [{ type: "text", text: `START${"中".repeat(6000)}END` }, image],
        },
        { ...entry("assistant"), type: "assistant", content: "a".repeat(10000) },
      ],
    };
    const compact = renderHistoryMarkdown(data, true);
    const full = renderHistoryMarkdown(data, false);
    expect(parseYaml(compact.split("\n---\n")[0].slice(4))).toEqual(data.session);
    expect(compact).toContain(
      `\`\`\`\`\`text\n${content}\n[image: image/png; binary data omitted]\nlast\n\`\`\`\`\``,
    );
    for (const text of [compact, full]) {
      expect(text).not.toContain("SECRET_BASE64");
      expect(text).toContain("a".repeat(10000));
    }
    const args = compact.match(/arguments:\n```text\n([\s\S]*?)\n```/)[1];
    const result = compact.match(/result:\n```text\n([\s\S]*?)\n```/)[1];
    expect(Buffer.byteLength(args)).toBeLessThanOrEqual(256 * BYTES_PER_TOKEN);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(512 * BYTES_PER_TOKEN);
    expect(result).toContain("START");
    expect(result).toContain("END");
    expect(args).toContain("… (truncated) …");
    expect(full).toContain("中".repeat(6000));
    expect(full).toContain("preserved caption");
    expect(full).toContain("https://example.com/image");
    expect(JSON.stringify(data)).toContain("SECRET_BASE64");
    data.entries[1].result = [{ type: "text", text: "payload", extra: "preserved field" }];
    expect(renderHistoryMarkdown(data, false)).toContain("preserved field");
  });
});
