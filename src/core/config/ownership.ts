import { loadModelResolver } from "../models/catalog.js";
import type { ConfigDeps } from "./deps.js";
import type { McpServersConfig } from "./mcp.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { loadConfigWithDiagnostics } from "./schema.js";

type ConfigOwner = "process" | "host" | "client" | "session";

// Every config field belongs to the process that may read it. Client and host startup directories
// must never decide session behavior, so adding a field requires choosing its owner here.
const CONFIG_FIELD_OWNERS = {
  apiKeys: "process",
  history: "host",
  flySprites: "host",
  defaultTheme: "client",
  markdownExport: "client",
  clientTools: "client",
  enabledClientTools: "client",
  defaultPersona: "session",
  subagents: "session",
  modelSystemNotices: "session",
  mcpServers: "session",
  speech: "split",
} as const satisfies Record<keyof Config, ConfigOwner | "split">;

const SPEECH_FIELD_OWNERS = {
  voiceId: "client",
  recordingShortcut: "client",
  vocabulary: "session",
} as const satisfies Record<keyof NonNullable<Config["speech"]>, "client" | "session">;

type FieldOwners = typeof CONFIG_FIELD_OWNERS;
type FieldsOwnedBy<Owner extends ConfigOwner> = {
  [Field in keyof FieldOwners]: FieldOwners[Field] extends Owner ? Field : never;
}[keyof FieldOwners];
type OwnedFields<Owner extends ConfigOwner> = Pick<Config, FieldsOwnedBy<Owner>>;

type ClientSpeechFields = {
  [Field in keyof typeof SPEECH_FIELD_OWNERS]: (typeof SPEECH_FIELD_OWNERS)[Field] extends "client"
    ? Field
    : never;
}[keyof typeof SPEECH_FIELD_OWNERS];

export type ClientSpeechConfig = Pick<NonNullable<Config["speech"]>, ClientSpeechFields> & {
  personalVocabulary: string[];
};

export type HostConfig = OwnedFields<"process" | "host">;

export type ClientConfig = OwnedFields<"process" | "client"> & {
  speech: ClientSpeechConfig;
};

export type SessionConfig = Omit<OwnedFields<"session">, "mcpServers"> & {
  /** Host credentials added by session bootstrap. Configuration on the target never supplies them. */
  apiKeys?: Config["apiKeys"];
  mcpServers: McpServersConfig;
  speechVocabulary: string[];
};

export type SessionRuntimeSettings = Pick<SessionConfig, "apiKeys" | "modelSystemNotices">;

function pickOwnedFields<Owner extends ConfigOwner>(
  config: Config,
  owners: readonly Owner[],
): OwnedFields<Owner> {
  return Object.fromEntries(
    Object.entries(CONFIG_FIELD_OWNERS).flatMap(([field, owner]) => {
      const value = config[field as keyof Config];
      return (owners as readonly string[]).includes(owner) && value !== undefined
        ? [[field, value]]
        : [];
    }),
  ) as OwnedFields<Owner>;
}

export function toHostConfig(config: Config): HostConfig {
  return pickOwnedFields(config, ["process", "host"]);
}

export function toClientConfig(config: Config, personalVocabulary: string[]): ClientConfig {
  const { voiceId, recordingShortcut } = config.speech ?? {};
  return {
    ...pickOwnedFields(config, ["process", "client"]),
    speech: {
      ...(voiceId !== undefined ? { voiceId } : {}),
      ...(recordingShortcut !== undefined ? { recordingShortcut } : {}),
      personalVocabulary,
    },
  };
}

export function toSessionConfig(config: Config): SessionConfig {
  return {
    ...pickOwnedFields(config, ["session"]),
    mcpServers: config.mcpServers ?? {},
    speechVocabulary: config.speech?.vocabulary ?? [],
  };
}

function loadConfigForDirectory(cwd: string, deps: ConfigDeps) {
  return loadConfigWithDiagnostics(deps, {
    levels: resolveConfigLevels(deps, { cwd }),
    modelResolver: loadModelResolver(),
  });
}

export function loadHostConfig(cwd: string, deps: ConfigDeps): HostConfig {
  return toHostConfig(loadConfigForDirectory(cwd, deps).config);
}

export function loadClientConfig(cwd: string, deps: ConfigDeps): ClientConfig {
  const { config, personalSpeechVocabulary } = loadConfigForDirectory(cwd, deps);
  return toClientConfig(config, personalSpeechVocabulary);
}

/** Reads what a session in `cwd` would use, for commands that act on that directory's sessions. */
export function loadSessionConfig(cwd: string, deps: ConfigDeps): SessionConfig {
  return toSessionConfig(loadConfigForDirectory(cwd, deps).config);
}
