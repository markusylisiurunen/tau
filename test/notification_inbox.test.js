import { expect, it } from "vitest";
import {
  createNotificationDelivery,
  NotificationInbox,
} from "../dist/core/agent/notification_inbox.js";
import { createNotificationsPackage } from "../dist/core/code_mode/notifications.js";

it("keeps unread and delivery state separate across package reads and concurrent arrivals", async () => {
  const inbox = new NotificationInbox();
  const { api } = createNotificationsPackage(inbox);
  const context = { signal: new AbortController().signal };
  const list = (options) => api.list(options ? [options] : [], context);
  const read = (id) => api.read([id], context);
  inbox.add("first", "details");
  const [first] = inbox.list().map((entry) => entry.id);
  await list();
  expect(inbox.list()[0].read).toBe(false);
  const signal = inbox.signal();
  inbox.add("second");
  inbox.delivered(signal);
  const second = inbox.list()[1].id;
  expect(inbox.hasUndelivered()).toBe(true);
  expect(inbox.signal().map((entry) => entry.id)).toEqual([first, second]);
  expect(await read(first)).toMatchObject({ id: first, read: true, body: "details" });
  expect(inbox.list()[0]).toMatchObject({ read: true, body: "details" });
  expect((await list()).map((entry) => entry.id)).toEqual([second]);
  expect((await list({ includeRead: true })).map((entry) => entry.id)).toEqual([first, second]);
  expect(inbox.signal().map((entry) => entry.id)).toEqual([second]);
  inbox.delivered(inbox.signal());
  expect(inbox.signal()).toBeUndefined();
  expect(inbox.list()[1].read).toBe(false);
  await expect(read("missing")).rejects.toMatchObject({ code: "unknown_notification" });
  inbox.add("third");
  await read(second);
  await read(inbox.list()[2].id);
  expect(inbox.signal()).toBeUndefined();
  expect(inbox.list()).toHaveLength(3);
});

it("bounds retained source data and discards the oldest records", () => {
  const inbox = new NotificationInbox();
  inbox.add("first");
  const first = inbox.list()[0].id;
  for (let i = 0; i < 256; i++) inbox.add("x".repeat(1024), "y".repeat(16384));
  expect(inbox.list()).toHaveLength(256);
  expect(inbox.read(first)).toBeUndefined();
  const delivery = createNotificationDelivery(inbox.signal());
  expect(delivery.listed.map((entry) => entry.id)).toEqual(
    inbox
      .list()
      .slice(-32)
      .map((entry) => entry.id),
  );
  expect(delivery.omitted).toBe(256 - 32);
  // History from before a restart names old IDs, so a new inbox must not reuse them.
  const restarted = new NotificationInbox();
  restarted.add("first");
  expect(restarted.list()[0].id).not.toBe(first);
  expect(
    inbox.list().every((entry) => entry.title.length < 1024 && entry.body.length < 16384),
  ).toBe(true);
});
