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
  personaId: z.string().optional(),
  reasoningOverride: ReasoningEffortSchema.optional(),
  riskLevel: RiskLevelSchema.optional(),
  withContext: z.boolean(),
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
  const reasoningValue = trimmed.slice(colonIndex + 1).toLowerCase();
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
  let personaId: string | undefined;
  let reasoningOverride: ReasoningEffort | undefined;
  let riskLevel: RiskLevel | undefined;
  let withContext = false;

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

    if (arg === "--with-context") {
      withContext = true;
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

  const options = { help, debug, personaId, reasoningOverride, riskLevel, withContext };
  return CliOptionsSchema.parse(options);
}

export function printHelp(personas: Persona[]): void {
  const personaList = personas.map((p) => p.id).join(", ");
  const reasoningList = [...REASONING_LEVELS, "default"].join(", ");
  const riskList = RiskLevelSchema.options.join(", ");

  console.log(
    [
      "tau - terminal chat",
      "",
      "usage:",
      "  tau [options]",
      "",
      "options:",
      "  --help                        show this help and exit.",
      "  --debug                       print debug info (personas, prompts, skills, system prompt) and exit.",
      `  --persona, -p <id>[:<level>]  start with a persona. available: ${personaList}.`,
      `                                optionally specify reasoning level. levels: ${reasoningList}.`,
      `                                if not specified, uses defaultPersona from ~/.config/tau/config.json.`,
      `  --risk, -r <level>            set initial model risk level. levels: ${riskList}.`,
      `                                if not specified, uses defaultRisk from ~/.config/tau/config.json (default: read-only).`,
      "  --with-context                inject AGENTS.md into the system prompt.",
      "",
      "examples:",
      "  tau --persona gpt-5.2-chat:high",
      "  tau -p opus-4.5-coder",
      "  tau --persona gpt-5.2-chat:medium --risk read-write",
      "  tau -p gpt-5.2-coder:high -r read-write",
      "",
      "notes:",
      "  you can switch persona during a session with /persona:<id>.",
      "  insert predefined prompt templates with /prompt:<id>.",
      "  you can change model risk level during a session with /risk:restricted|read-only|read-write.",
      "  if stdin is piped, its contents are sent as the first message automatically.",
      "  reasoning only affects providers that support it.",
    ].join("\n"),
  );
}
