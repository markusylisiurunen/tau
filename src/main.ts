#!/usr/bin/env node
import type { CliOptions, Persona, PromptTemplate, ReasoningEffort, Skill } from "./core/index.js";
import {
  applyGeminiSubagents,
  personas as builtinPersonas,
  prompts as builtinPrompts,
  CliError,
  createBashToolDefinition,
  createEditToolDefinition,
  createForkToolDefinition,
  createGrepToolDefinition,
  createListToolDefinition,
  createReadToolDefinition,
  createTaskToolDefinition,
  createWriteToolDefinition,
  isGoogleAuthAvailable,
  loadAllContent,
  loadBashCommands,
  loadConfig,
  parseCliArgs,
  parsePersonaString,
  printDebugInfo,
  printHelp,
  ToolRegistry,
} from "./core/index.js";
import { ChatApp } from "./tui/index.js";

// Load configuration from file
const config = loadConfig(process.cwd());

const bashCommands = loadBashCommands(process.cwd()).commands;

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;

  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

// Load built-in and user content
let personas: Persona[];
let prompts: PromptTemplate[];
let skills: Skill[];
try {
  const content = await loadAllContent(config);
  personas = content.personas;
  prompts = content.prompts;
  skills = content.skills;
} catch (err) {
  // Safeguard: loadAllContent should not throw, but wrap to ensure tau --help works
  // eslint-disable-next-line no-console
  console.error(`warning: failed to load user content: ${(err as Error).message}`);

  const baseBuiltins = isGoogleAuthAvailable(config)
    ? applyGeminiSubagents(builtinPersonas)
    : builtinPersonas;
  const effectiveBuiltins = config.disableBuiltinPersonas ? [] : baseBuiltins;

  // eslint-disable-next-line no-console
  console.error(
    effectiveBuiltins.length > 0
      ? "using built-in personas and prompts only."
      : "no built-in personas available (disableBuiltinPersonas is enabled).",
  );

  personas = effectiveBuiltins;
  prompts = builtinPrompts;
  skills = [];
}

let cli: CliOptions;
try {
  cli = parseCliArgs(process.argv.slice(2), personas);
} catch (err) {
  if (err instanceof CliError) {
    // eslint-disable-next-line no-console
    console.error(err.message);
    // eslint-disable-next-line no-console
    console.error("");
    printHelp(personas);
    process.exit(1);
  }
  throw err;
}

if (cli.help) {
  printHelp(personas);
  process.exit(0);
}

if (cli.debug) {
  let debugPersonaId: string | undefined;
  let debugReasoningOverride: ReasoningEffort | undefined;

  if (cli.personaId) {
    debugPersonaId = cli.personaId;
  } else if (config.defaultPersona) {
    const parsed = parsePersonaString(config.defaultPersona, personas);
    debugPersonaId = parsed.personaId;
    debugReasoningOverride = parsed.reasoning;
  }

  if (cli.reasoningOverride !== undefined) {
    debugReasoningOverride = cli.reasoningOverride;
  }

  let debugPersona: Persona | undefined;
  if (personas.length > 0) {
    debugPersona = debugPersonaId
      ? (personas.find((p) => p.id === debugPersonaId) ?? personas[0]!)
      : personas[0]!;

    if (debugReasoningOverride !== undefined) {
      debugPersona.settings.reasoning = debugReasoningOverride;
    }
  }

  const debugRiskLevel = cli.riskLevel ?? config.defaultRisk ?? "read-only";
  const debugToolRegistry = new ToolRegistry([
    createBashToolDefinition(),
    createWriteToolDefinition(),
    createEditToolDefinition(),
    createTaskToolDefinition(),
    createForkToolDefinition(),
    createReadToolDefinition(),
    createGrepToolDefinition(),
    createListToolDefinition(),
  ]);
  printDebugInfo({
    personas,
    prompts,
    bashCommands,
    skills,
    selectedPersona: debugPersona,
    withContext: cli.withContext,
    riskLevel: debugRiskLevel,
    toolRegistry: debugToolRegistry,
  });
  process.exit(0);
}

if (personas.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    "error: no personas available. Add a custom persona in ~/.config/tau/personas or .tau/personas, or unset disableBuiltinPersonas.",
  );
  process.exit(1);
}

let initialPersonaId: string | undefined;
let reasoningOverride: ReasoningEffort | undefined = cli.reasoningOverride;

if (cli.personaId) {
  initialPersonaId = cli.personaId;
} else if (config.defaultPersona) {
  const parsed = parsePersonaString(config.defaultPersona, personas);
  initialPersonaId = parsed.personaId;
  if (reasoningOverride === undefined) {
    reasoningOverride = parsed.reasoning;
  }
}

const initialPersona = initialPersonaId
  ? (personas.find((p) => p.id === initialPersonaId) ?? personas[0]!)
  : personas[0]!;

if (reasoningOverride !== undefined) {
  initialPersona.settings.reasoning = reasoningOverride;
}

const initialRiskLevel = cli.riskLevel || config.defaultRisk;

const initialUserMessage = await readPipedStdin();

const app = new ChatApp({
  personas,
  prompts,
  skills,
  bashCommands,
  initialPersonaId,
  initialUserMessage,
  initialRiskLevel,
  withContext: cli.withContext,
  themePreview: cli.themePreview,
  config,
});

try {
  await app.start();
} catch (err) {
  app.stop();
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
