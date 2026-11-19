import { unavailable } from "../../dist/core/agent/capabilities.js";
import { NotificationInbox } from "../../dist/core/agent/notification_inbox.js";
import { McpManager } from "../../dist/core/mcp/manager.js";
import { createCodeTool } from "../../dist/core/tools/code.js";
import { CodeJobRegistry } from "../../dist/core/tools/code_jobs.js";

export function createPackageTool(backend, pkg) {
  return createCodeTool({
    backend,
    cwd: process.cwd(),
    codeJobs: new CodeJobRegistry(),
    summaries: [pkg],
    packagesFor: () => [pkg],
  });
}

/** The `createCodeToolDefinition` options every test needs, for an agent without optional capabilities. */
export function codeToolDefaults() {
  return {
    history: {},
    mcp: new McpManager(),
    notifications: new NotificationInbox(),
    capabilities: {
      delegation: unavailable("test"),
      completionNotifications: unavailable("test"),
      web: unavailable("test"),
    },
  };
}
