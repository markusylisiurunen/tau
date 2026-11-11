import { expect, it } from "vitest";
import { NotificationInbox } from "../dist/core/agent/notification_inbox.js";
import { createNotificationTools } from "../dist/core/tools/notifications.js";

it("keeps unread and delivery state separate across tool reads and concurrent arrivals", async () => {
  const inbox = new NotificationInbox();
  const tools = createNotificationTools(inbox);
  const context = { signal: new AbortController().signal };
  const execute = (name, args) =>
    tools
      .find((tool) => tool.schema.name === name)
      .execute({ id: "call", name, arguments: args }, context);
  inbox.add("first", "details");
  const [first] = inbox.list().map((entry) => entry.id);
  await execute("list_notifications", {});
  expect(inbox.list()[0].read).toBe(false);
  const signal = inbox.signal();
  inbox.add("second");
  inbox.delivered(signal);
  const second = inbox.list()[1].id;
  expect(inbox.hasUndelivered()).toBe(true);
  expect(inbox.signal().map((entry) => entry.id)).toEqual([first, second]);
  expect((await execute("read_notification", { id: first })).outcome).toBe("succeeded");
  expect(inbox.list()[0]).toMatchObject({ read: true, body: "details" });
  const unread = await execute("list_notifications", {});
  expect(unread.content[0].text).not.toContain(first);
  expect((await execute("list_notifications", { includeRead: true })).content[0].text).toContain(
    first,
  );
  expect(inbox.signal().map((entry) => entry.id)).toEqual([second]);
  inbox.delivered(inbox.signal());
  expect(inbox.signal()).toBeUndefined();
  expect(inbox.list()[1].read).toBe(false);
  expect((await execute("read_notification", { id: "missing" })).outcome).toBe("failed");
  inbox.add("third");
  await execute("read_notification", { id: second });
  await execute("read_notification", { id: inbox.list()[2].id });
  expect(inbox.signal()).toBeUndefined();
  expect(inbox.list()).toHaveLength(3);
});

it("bounds retained source data and discards the oldest records", () => {
  const inbox = new NotificationInbox();
  inbox.add("first");
  const first = inbox.list()[0].id;
  for (let i = 0; i < 256; i++) inbox.add("x".repeat(1024), "y".repeat(16384));
  expect(inbox.list()).toHaveLength(256);
  expect(() => inbox.read(first)).toThrow();
  // History from before a restart names old IDs, so a new inbox must not reuse them.
  const restarted = new NotificationInbox();
  restarted.add("first");
  expect(restarted.list()[0].id).not.toBe(first);
  expect(
    inbox.list().every((entry) => entry.title.length <= 512 && entry.body.length <= 8192),
  ).toBe(true);
});
