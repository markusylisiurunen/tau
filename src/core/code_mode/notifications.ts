import { z } from "zod";
import { codeModeError } from "../../code_mode/errors.js";
import { MAX_NOTIFICATIONS, type NotificationInbox } from "../agent/notification_inbox.js";
import { type CodeModePackage, definePackage, method } from "./package.js";

export function createNotificationsPackage(inbox: NotificationInbox): CodeModePackage {
  return definePackage(
    "notifications",
    "List and read notifications Tau delivers to you, such as workers that became idle.",
    {
      list: method(
        z.tuple([z.strictObject({ includeRead: z.boolean().optional() }).optional()]),
        ([options]) =>
          inbox
            .list()
            .filter((entry) => options?.includeRead || !entry.read)
            .map(({ id, title, read }) => ({ id, title, read })),
      ),
      read: method(z.tuple([z.string().min(1).max(256)]), ([id]) => {
        const notification = inbox.read(id);
        if (!notification) {
          throw codeModeError(
            "unknown_notification",
            `Unknown notification ${id}. Only the ${MAX_NOTIFICATIONS} newest are kept, and none survive a restart.`,
          );
        }
        return notification;
      }),
    },
  );
}
