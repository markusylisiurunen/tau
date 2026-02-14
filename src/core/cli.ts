import { z } from "zod";
import {
  type Persona,
  REASONING_LEVELS,
  type ReasoningEffort,
  ReasoningEffortSchema,
  type RiskLevel,
  RiskLevelSchema,
} from "./types.js";

export const CliOptionsSchema = z.object({
  help: z.boolean(),
  debug: z.boolean(),
  loadPath: z.string().optional(),
  personaId: z.string().optional(),
  reasoningOverride: ReasoningEffortSchema.optional(),
  riskLevel: RiskLevelSchema.optional(),
  sandbox: z.boolean(),
  caffeinated: z.boolean(),
  noAgentContextFiles: z.boolean(),
});

export type CliOptions = z.infer<typeof CliOptionsSchema>;

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function resolvePersonaId(raw: string, personas: Persona[]): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const exact = personas.find((p) => p.id === trimmed);
  if (exact) return exact.id;
  const lower = trimmed.toLowerCase();
  return personas.find((p) => p.id.toLowerCase() === lower)?.id;
}

export function parsePersonaString(
  raw: string,
  personas: Persona[],
): { personaId: string | undefined; reasoning: ReasoningEffort | undefined } {
  const trimmed = raw.trim();
  if (!trimmed) return { personaId: undefined, reasoning: undefined };

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return { personaId: resolvePersonaId(trimmed, personas), reasoning: undefined };
  }

  const personaValue = trimmed.slice(0, colonIndex);
  const reasoningValue = trimmed
    .slice(colonIndex + 1)
    .trim()
    .toLowerCase();
  const personaId = resolvePersonaId(personaValue, personas);
  const reasoning = (REASONING_LEVELS as string[]).includes(reasoningValue)
    ? (reasoningValue as ReasoningEffort)
    : undefined;

  return { personaId, reasoning };
}

function parseRiskLevel(raw: string): RiskLevel {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new CliError("missing value for --risk");
  }

  const parsed = RiskLevelSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }

  const allowed = RiskLevelSchema.options.join(", ");
  throw new CliError(`invalid risk level '${raw}'. allowed levels: ${allowed}`);
}

function parseValue(
  arg: string,
  argv: string[],
  index: number,
): { value: string; nextIndex: number } {
  const eqIndex = arg.indexOf("=");
  if (eqIndex !== -1) {
    const value = arg.slice(eqIndex + 1);
    if (!value) {
      throw new CliError(`missing value for ${arg.slice(0, eqIndex)}`);
    }
    return { value, nextIndex: index };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new CliError(`missing value for ${arg}`);
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseCliArgs(argv: string[], personas: Persona[]): CliOptions {
  let help = false;
  let debug = false;
  let loadPath: string | undefined;
  let personaId: string | undefined;
  let reasoningOverride: ReasoningEffort | undefined;
  let riskLevel: RiskLevel | undefined;
  let sandbox = false;
  let caffeinated = false;
  let noAgentContextFiles = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--debug") {
      debug = true;
      continue;
    }

    if (arg === "--load" || arg === "-l" || arg.startsWith("--load=") || arg.startsWith("-l=")) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;
      loadPath = value;
      continue;
    }

    if (arg === "--no-agent-context-files") {
      noAgentContextFiles = true;
      continue;
    }

    if (arg === "--sandbox") {
      sandbox = true;
      continue;
    }

    if (arg === "--caffeinated") {
      caffeinated = true;
      continue;
    }

    if (
      arg === "--persona" ||
      arg === "-p" ||
      arg.startsWith("--persona=") ||
      arg.startsWith("-p=")
    ) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;

      const parsed = parsePersonaString(value, personas);
      if (!parsed.personaId) {
        const colonIndex = value.indexOf(":");
        const personaValue = colonIndex !== -1 ? value.slice(0, colonIndex) : value;
        const available = personas.map((p) => p.id).join(", ");
        throw new CliError(`unknown persona '${personaValue}'. available personas: ${available}`);
      }
      const colonIndex = value.indexOf(":");
      if (colonIndex !== -1) {
        const reasoningValue = value
          .slice(colonIndex + 1)
          .trim()
          .toLowerCase();
        if (!reasoningValue) {
          throw new CliError("missing reasoning level after ':' in --persona");
        }
        if (parsed.reasoning === undefined) {
          const allowed = [...REASONING_LEVELS].join(", ");
          throw new CliError(
            `invalid reasoning level '${reasoningValue}'. allowed levels: ${allowed}`,
          );
        }
      }
      personaId = parsed.personaId;
      if (parsed.reasoning !== undefined) {
        reasoningOverride = parsed.reasoning;
      }

      continue;
    }

    if (arg === "--risk" || arg === "-r" || arg.startsWith("--risk=") || arg.startsWith("-r=")) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;
      riskLevel = parseRiskLevel(value);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`unknown option: ${arg}`);
    }
    throw new CliError(`unexpected argument: ${arg}`);
  }

  const options = {
    help,
    debug,
    loadPath,
    personaId,
    reasoningOverride,
    riskLevel,
    sandbox,
    caffeinated,
    noAgentContextFiles,
  };
  return CliOptionsSchema.parse(options);
}

export function printHelp(personas: Persona[]): void {
  const personaList = personas.map((p) => p.id).join(", ");
  const reasoningList = REASONING_LEVELS.join(", ");
  const riskList = RiskLevelSchema.options.join(", ");

  console.log(
    [
      "tau - terminal chat",
      "",
      "usage:",
      "  tau [options]",
      "  tau rpc [options]",
      "  tau auth <subcommand>",
      "  tau usage [options]",
      "  tau install [options]",
      "  tau async <command>",
      "",
      "options:",
      "  --help                        show this help and exit.",
      "  --debug                       print debug info (personas, prompts, skills, system prompt) and exit.",
      "  --load, -l <file>             load a checkpoint file.",
      `  --persona, -p <id>[:<level>]  start with a persona. available: ${personaList}.`,
      `                                optionally specify reasoning level. levels: ${reasoningList}.`,
      `                                if not specified, uses defaultPersona from ~/.config/tau/config.json.`,
      `  --risk, -r <level>            set initial model risk level. levels: ${riskList}.`,
      `                                if not specified, uses defaultRisk from ~/.config/tau/config.json (default: read-only).`,
      "  --sandbox                     run all tool execution inside a session docker container.",
      "  --caffeinated                 keep macOS awake during active assistant turns in TUI mode (no-op on Linux).",
      "  --no-agent-context-files      disable AGENTS.md injection into the system prompt.",
      "",
      "subcommands:",
      "  rpc                           run headless stdio RPC mode (no TUI).",
      "  auth                          authenticate/list/logout Codex OAuth accounts.",
      "  usage                         summarize usage logs.",
      "  install                       install starter prompts and skills.",
      "  async                         run async daemon/client commands.",
      "",
      "examples:",
      "  tau --persona gpt-5.2-chat:high",
      "  tau -p opus-4.6-coder",
      "  tau --persona gpt-5.2-chat:medium --risk read-write",
      "  tau -p gpt-5.2-coder:high -r read-write",
      "  tau -l /tmp/tau-checkpoint-abc123/checkpoint.json",
      "",
      "notes:",
      "  use `tau auth login codex` to authenticate ChatGPT subscription credentials.",
      "  use `tau auth logout codex --account <email>` to remove stored OAuth credentials.",
      "  use `tau usage` to view daily usage totals from ~/.config/tau/logs.",
      "  use `tau install` to install starter prompts and skills.",
      "  you can switch persona during a session with /persona:<id>.",
      "  insert prompt templates with /prompt:<id>.",
      "  you can change model risk level during a session with /risk:read-only or /risk:read-write.",
      "  if stdin is piped, its contents are sent as the first message automatically in TUI mode.",
      "  in RPC mode, stdin/stdout are reserved for protocol traffic.",
      "  reasoning only affects providers that support it.",
    ].join("\n"),
  );
}
