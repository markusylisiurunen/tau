import type { ReasoningEffort } from "@mariozechner/pi-ai";
import { REASONING_LEVELS, type Persona, type ToolAccessLevel } from "./types.js";

export interface CliOptions {
  help: boolean;
  personaId?: string;
  reasoningEffort: ReasoningEffort | undefined;
  reasoningSpecified: boolean;
  toolAccessLevel?: ToolAccessLevel;
  noContext: boolean;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const TOOL_LEVELS: ToolAccessLevel[] = ["none", "read", "all"];

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
    throw new CliError("missing value for --reasoning");
  }
  if (normalized === "default" || normalized === "auto" || normalized === "none") {
    return undefined;
  }
  if ((REASONING_LEVELS as string[]).includes(normalized)) {
    return normalized as ReasoningEffort;
  }
  const allowed = [...REASONING_LEVELS, "default"].join(", ");
  throw new CliError(`invalid reasoning level '${raw}'. allowed levels: ${allowed}`);
}

function parseToolAccessLevel(raw: string): ToolAccessLevel {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new CliError("missing value for --tool");
  }
  if ((TOOL_LEVELS as string[]).includes(normalized)) {
    return normalized as ToolAccessLevel;
  }
  const allowed = TOOL_LEVELS.join(", ");
  throw new CliError(`invalid tool level '${raw}'. allowed levels: ${allowed}`);
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
  let personaId: string | undefined;
  let reasoningSpecified = false;
  let reasoningEffort: ReasoningEffort | undefined;
  let toolAccessLevel: ToolAccessLevel | undefined;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--no-context") {
      noContext = true;
      continue;
    }

    if (arg === "--persona" || arg.startsWith("--persona=")) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;
      const resolved = resolvePersonaId(value, personas);
      if (!resolved) {
        const available = personas.map((p) => p.id).join(", ");
        throw new CliError(`unknown persona '${value}'. available personas: ${available}`);
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

    if (arg === "--tool" || arg.startsWith("--tool=")) {
      const { value, nextIndex } = parseValue(arg, argv, i);
      i = nextIndex;
      toolAccessLevel = parseToolAccessLevel(value);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`unknown option: ${arg}`);
    }
    throw new CliError(`unexpected argument: ${arg}`);
  }

  return { help, personaId, reasoningEffort, reasoningSpecified, toolAccessLevel, noContext };
}

export function printHelp(personas: Persona[]): void {
  const personaList = personas.map((p) => p.id).join(", ");
  const reasoningList = [...REASONING_LEVELS, "default"].join(", ");
  const toolList = TOOL_LEVELS.join(", ");

  console.log(
    [
      "tau - terminal chat",
      "",
      "usage:",
      "  tau [options]",
      "",
      "options:",
      "  --help                 show this help and exit.",
      `  --persona <id>         start with a persona. available: ${personaList}.`,
      `  --reasoning <level>    set reasoning effort for initial persona. levels: ${reasoningList}.`,
      `  --tool <level>         set initial model tool access level. levels: ${toolList}. default: read.`,
      "  --no-context           do not inject AGENTS.md into the system prompt.",
      "",
      "notes:",
      "  you can switch persona during a session with /persona:<id>.",
      "  insert predefined prompt templates with /prompt:<id>.",
      "  you can change model tool access during a session with /tool:none|read|all.",
      "  if stdin is piped, its contents are sent as the first message automatically.",
      "  reasoning only affects providers that support it.",
    ].join("\n"),
  );
}
