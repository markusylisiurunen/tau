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
  await execute("list_notifications", {});
  expect(inbox.list()[0].read).toBe(false);
  const signal = inbox.signal();
  inbox.add("second");
  inbox.delivered(signal);
  expect(inbox.hasUndelivered()).toBe(true);
  expect(inbox.signal().notifications.map((entry) => entry.id)).toEqual(["n-1", "n-2"]);
  expect((await execute("read_notification", { id: "n-1" })).outcome).toBe("succeeded");
  expect(inbox.list()[0]).toMatchObject({ read: true, body: "details" });
  expect(inbox.signal().notifications.map((entry) => entry.id)).toEqual(["n-2"]);
  inbox.delivered(inbox.signal());
  expect(inbox.signal()).toBeUndefined();
  expect(inbox.list()[1].read).toBe(false);
  expect((await execute("read_notification", { id: "missing" })).outcome).toBe("failed");
  inbox.add("third");
  await execute("read_notification", { id: "n-2" });
  await execute("read_notification", { id: "n-3" });
  expect(inbox.signal()).toBeUndefined();
  expect(inbox.list()).toHaveLength(3);
});

it("bounds retained source data and discards the oldest records", () => {
  const inbox = new NotificationInbox();
  for (let i = 0; i < 257; i++) inbox.add("x".repeat(1024), "y".repeat(16384));
  expect(inbox.list()).toHaveLength(256);
  expect(() => inbox.read("n-1")).toThrow();
  expect(
    inbox.list().every((entry) => entry.title.length <= 512 && entry.body.length <= 8192),
  ).toBe(true);
});
