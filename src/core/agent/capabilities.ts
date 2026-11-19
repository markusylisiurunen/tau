import { codeModeError } from "../../code_mode/errors.js";
import { type ApiKeysConfig, getExaApiKey, getOpenRouterApiKey } from "../config/index.js";

export type Availability = { available: true } | { available: false; reason: string };

/**
 * What one agent can do beyond its fixed tools and packages. Every agent sees the same
 * interface, and these decide which calls succeed. The system prompt and the call-time
 * checks both derive from this object, so what the agent is told matches what happens.
 */
export type AgentCapabilities = {
  /** Starting and managing workers through `@tau/agents` and `wait_for_agents`. */
  delegation: Availability;
  /** Workers this agent starts notify it when they finish. */
  completionNotifications: Availability;
  /** Web search and fetch through `@tau/web`. */
  web: Availability;
  /** Model calls through `@tau/models`. */
  models: Availability;
};

export const AVAILABLE: Availability = { available: true };

export function unavailable(reason: string): Availability {
  return { available: false, reason };
}

function webAvailability(config: ApiKeysConfig): Availability {
  return getExaApiKey(config) ? AVAILABLE : unavailable("no Exa API key is configured");
}

function modelsAvailability(config: ApiKeysConfig): Availability {
  return getOpenRouterApiKey(config)
    ? AVAILABLE
    : unavailable("no OpenRouter API key is configured");
}

export function mainAgentCapabilities(options: {
  notifications: boolean;
  config: ApiKeysConfig;
}): AgentCapabilities {
  return {
    delegation: AVAILABLE,
    completionNotifications: options.notifications
      ? AVAILABLE
      : unavailable("this session has completion notifications turned off"),
    web: webAvailability(options.config),
    models: modelsAvailability(options.config),
  };
}

/** A worker, or a side context such as diff review, which the main agent does not drive. */
export function workerCapabilities(options: {
  delegation: Availability;
  config: ApiKeysConfig;
}): AgentCapabilities {
  return {
    delegation: options.delegation,
    completionNotifications: unavailable("only the main agent is notified when subagents finish"),
    web: webAvailability(options.config),
    models: modelsAvailability(options.config),
  };
}

/** The error a program sees when it calls something it cannot use. */
export function unavailableError(what: string, reason: string): Error & { code: string } {
  return codeModeError("unavailable", `${what} is unavailable: ${reason}.`);
}

export function requireCapability(availability: Availability, what: string): void {
  if (!availability.available) throw unavailableError(what, availability.reason);
}

/** Lists the capabilities this agent lacks, or nothing when it has them all. */
export function formatCapabilitiesForPrompt(capabilities: AgentCapabilities): string | undefined {
  const lines: string[] = [];
  const { delegation, completionNotifications, web, models } = capabilities;
  if (!delegation.available) {
    lines.push(
      `- Starting and managing subagents with \`@tau/agents\` and \`wait_for_agents\`: ${delegation.reason}.`,
    );
  } else if (!completionNotifications.available) {
    lines.push(
      `- Completion notifications: ${completionNotifications.reason}. Subagents you start do not notify you when they finish, so wait for them with \`wait_for_agents\` or \`waitUntilIdle\` before you rely on their results.`,
    );
  }
  if (!web.available) {
    lines.push(`- Web search and fetch in \`@tau/web\`: ${web.reason}. \`discover\` still works.`);
  }
  if (!models.available) {
    lines.push(`- Model calls in \`@tau/models\`: ${models.reason}. \`list\` still works.`);
  }
  if (!lines.length) return undefined;
  return [
    "## Unavailable capabilities",
    "",
    'These capabilities are unavailable to you. Calls that need them fail with `code: "unavailable"`, so do not plan around them.',
    "",
    ...lines,
  ].join("\n");
}
