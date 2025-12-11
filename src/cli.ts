import type { ReasoningEffort } from "@mariozechner/pi-ai";
import type { Persona } from "./types.js";

export interface CliOptions {
  help: boolean;
  personaId?: string;
  reasoningEffort: ReasoningEffort | undefined;
  reasoningSpecified: boolean;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const REASONING_LEVELS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function resolvePersonaId(raw: string, personas: Persona[]): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const exact = personas.find((p) => p.id === trimmed);
  if (exact) return exact.id;
  const lower = trimmed.toLowerCase();
  return personas.find((p) => p.id.toLowerCase() === lower)?.id;
}

function parseReasoning(raw: string): ReasoningEffort | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new CliError("Missing value for --reasoning");
  }
  if (normalized === "default" || normalized === "auto" || normalized === "none") {
    return undefined;
  }
  if ((REASONING_LEVELS as string[]).includes(normalized)) {
    return normalized as ReasoningEffort;
  }
  const allowed = [...REASONING_LEVELS, "default"].join(", ");
  throw new CliError(`Invalid reasoning level '${raw}'. Allowed levels: ${allowed}`);
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
      throw new CliError(`Missing value for ${arg.slice(0, eqIndex)}`);
    }
    return { value, nextIndex: index };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new CliError(`Missing value for ${arg}`);
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseCliArgs(argv: string[], personas: Persona[]): CliOptions {
  let help = false;
  let personaId: string | undefined;
  let reasoningSpecified = false;
  let reasoningEffort: ReasoningEffort | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--persona" || arg.startsWith("--persona=")) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;
      const resolved = resolvePersonaId(value, personas);
      if (!resolved) {
        const available = personas.map((p) => p.id).join(", ");
        throw new CliError(`Unknown persona '${value}'. Available personas: ${available}`);
      }
      personaId = resolved;
      continue;
    }

    if (arg === "--reasoning" || arg.startsWith("--reasoning=")) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;
      reasoningSpecified = true;
      reasoningEffort = parseReasoning(value);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`Unknown option: ${arg}`);
    }
    throw new CliError(`Unexpected argument: ${arg}`);
  }

  return { help, personaId, reasoningEffort, reasoningSpecified };
}

export function printHelp(personas: Persona[]): void {
  const personaList = personas.map((p) => p.id).join(", ");
  const reasoningList = [...REASONING_LEVELS, "default"].join(", ");

  console.log(
    [
      "tau - terminal chat",
      "",
      "Usage:",
      "  tau [options]",
      "",
      "Options:",
      "  --help                 Show this help and exit.",
      `  --persona <id>         Start with a persona. Available: ${personaList}`,
      `  --reasoning <level>    Set reasoning effort for initial persona. Levels: ${reasoningList}`,
      "",
      "Notes:",
      "  You can switch persona during a session with /persona:<id>.",
      "  Reasoning only affects providers that support it.",
    ].join("\n"),
  );
}
