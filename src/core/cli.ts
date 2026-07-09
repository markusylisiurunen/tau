import { parsePersonaReference } from "./persona_reference.js";
import {
  type Persona,
  REASONING_LEVELS,
  type ReasoningEffort,
  type RiskLevel,
  RiskLevelSchema,
} from "./types.js";

export type CliOptions = {
  help: boolean;
  debug: boolean;
  personaId?: string;
  reasoningOverride?: ReasoningEffort;
  riskLevel?: RiskLevel;
  caffeinated: boolean;
  noAgentContextFiles: boolean;
};

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function resolvePersonaId(raw: string, personas: Persona[]): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return personas.find((p) => p.id === trimmed)?.id;
}

export function parsePersonaString(
  raw: string,
  personas: Persona[],
): { personaId: string | undefined; reasoning: ReasoningEffort | undefined } {
  const parsed = parsePersonaReference(raw);
  if (!parsed.personaId || parsed.error) {
    return { personaId: undefined, reasoning: undefined };
  }

  const personaId = resolvePersonaId(parsed.personaId, personas);
  return {
    personaId,
    reasoning: personaId ? parsed.reasoning : undefined,
  };
}

function parsePersonaOption(
  raw: string,
  personas: Persona[],
): { personaId: string; reasoningOverride: ReasoningEffort | undefined } {
  const parsedReference = parsePersonaReference(raw);

  if (parsedReference.error === "missing-reasoning") {
    throw new CliError("missing reasoning level after ':' in --persona");
  }

  if (parsedReference.error === "invalid-reasoning") {
    const allowed = REASONING_LEVELS.join(", ");
    throw new CliError(
      `invalid reasoning level '${parsedReference.rawReasoning}'. allowed levels: ${allowed}`,
    );
  }

  if (!parsedReference.personaId) {
    throw new CliError("missing persona id in --persona");
  }

  const personaId = resolvePersonaId(parsedReference.personaId, personas);
  if (!personaId) {
    const available = personas.map((p) => p.id).join(", ");
    throw new CliError(
      `unknown persona '${parsedReference.personaId}'. available personas: ${available}`,
    );
  }

  return {
    personaId,
    reasoningOverride: parsedReference.reasoning,
  };
}

function parseRiskOption(raw: string): RiskLevel {
  const normalized = raw.trim();
  if (!normalized) {
    throw new CliError("missing value for --risk");
  }

  const parsed = RiskLevelSchema.safeParse(normalized);
  if (!parsed.success) {
    const allowed = RiskLevelSchema.options.join(", ");
    throw new CliError(`invalid risk level '${raw}'. allowed levels: ${allowed}`);
  }

  return parsed.data;
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

    if (arg === "--no-agent-context-files") {
      noAgentContextFiles = true;
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
      const parsed = parseValue(arg, argv, i);
      const persona = parsePersonaOption(parsed.value, personas);
      personaId = persona.personaId;
      reasoningOverride = persona.reasoningOverride;
      i = parsed.nextIndex;
      continue;
    }

    if (arg === "--risk" || arg === "-r" || arg.startsWith("--risk=") || arg.startsWith("-r=")) {
      const parsed = parseValue(arg, argv, i);
      riskLevel = parseRiskOption(parsed.value);
      i = parsed.nextIndex;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`unknown option: ${arg}`);
    }

    throw new CliError(`unexpected argument: ${arg}`);
  }

  return {
    help,
    debug,
    personaId,
    reasoningOverride,
    riskLevel,
    caffeinated,
    noAgentContextFiles,
  };
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
      "  tau serve [--host <host>] [--port <port>] [options]",
      "  tau attach [--session <id> | --new --cwd <path> [execution options]] [--auth-token <token>] ws://host:port",
      "  tau attach [--session <id> | --new --cwd <path> [execution options]] -- <command> [args...]",
      "  tau auth <subcommand>",
      "  tau usage [options]",
      "  tau install [options]",
      "  tau nook <subcommand>",
      "  tau tool <command>",
      "  tau telegram --config-file <path>",
      "  tau diff-tool [--help]",
      "",
      "options:",
      "  --help                        show this help and exit.",
      "  --debug                       print debug info (personas, prompts, skills, system prompt) and exit.",
      `  --persona, -p <id>[:<level>]  start with a persona. available: ${personaList}.`,
      `                                optionally specify reasoning level. levels: ${reasoningList}.`,
      `                                if not specified, uses resolved config defaultPersona.`,
      `  --risk, -r <level>            set initial model risk level. levels: ${riskList}.`,
      `                                if not specified, uses resolved config defaultRisk (default: read-only).`,
      "  --caffeinated                 keep macOS awake during active assistant turns in TUI mode (no-op on Linux).",
      "  --no-agent-context-files      disable AGENTS.md injection into the system prompt.",
      "",
      "subcommands:",
      "  rpc                           run headless stdio RPC mode (no TUI).",
      "  serve                         host Tau sessions over WebSocket.",
      "  attach                        run the TUI against a session-protocol transport.",
      "  auth                          authenticate/list/logout Codex OAuth accounts.",
      "  usage                         summarize usage logs.",
      "  install                       install starter prompts and skills.",
      "  nook                          deploy static mini-apps and manage Nook templates.",
      "  tool                          run built-in utility tools.",
      "  telegram                      run the Telegram bot adapter.",
      "  diff-tool                     built-in browser diff review demo tool.",
      "",
      "examples:",
      "  tau --persona gpt-5.4-chat:high",
      "  tau -p opus-4.8-coder",
      "  tau --persona gpt-5.4-chat:medium --risk read-write",
      "  tau -p gpt-5.4-coder:high -r read-write",
      "  tau serve --host 0.0.0.0 --port 8787 --risk read-only",
      "  tau attach --new --cwd /repo ws://127.0.0.1:8787",
      "  tau attach ws://127.0.0.1:8787",
      "  tau attach --new --cwd /repo -- ssh vps 'tau rpc --risk read-only'",
      "",
      "notes:",
      "  use `tau auth login codex` to authenticate ChatGPT subscription credentials.",
      "  use `tau auth logout codex --account <email>` to remove stored OAuth credentials.",
      "  use `tau usage` to view daily usage totals from ~/.config/tau/logs.",
      "  use `tau install` to install starter prompts and skills.",
      "  use `tau nook --help` to deploy static mini-apps and manage Nook templates.",
      "  use `tau tool pdf-unpack <file.pdf>` to extract markdown and page image patches from a PDF.",
      "  /diff opens the local diff review tool and delegates review work to the session host.",
      "  you can switch persona during a session with /persona:<id>.",
      "  insert prompt templates with /prompt:<id>.",
      "  you can change model risk level during a session with /risk:read-only or /risk:read-write.",
      "  if stdin is piped, its contents are sent as the first message automatically in TUI mode.",
      "  in RPC mode, stdin/stdout are reserved for protocol traffic.",
      "  reasoning only affects providers that support it.",
    ].join("\n"),
  );
}

export function printDiffToolHelp(): void {
  console.log(
    [
      "usage:",
      "  tau diff-tool [--help]",
      "",
      "the built-in browser diff review demo tool and reference implementation for the diff-review protocol.",
      "it expects TAU_DIFF_* environment variables from a diff-review session and is primarily useful for protocol development.",
      "",
      "examples:",
      "  tau diff-tool --help",
    ].join("\n"),
  );
}
