#!/usr/bin/env node
import { ChatApp } from "./app.js";
import type { CliOptions } from "./cli.js";
import { CliError, parseCliArgs, printHelp } from "./cli.js";
import { loadConfig } from "./config.js";
import { loadAllContent } from "./content_loader.js";
import type { PromptTemplate } from "./prompts.js";
import type { Persona } from "./types.js";

// Load configuration from file
const config = loadConfig();

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
try {
  const content = await loadAllContent();
  personas = content.personas;
  prompts = content.prompts;
} catch (err) {
  // Safeguard: loadAllContent should not throw, but wrap to ensure tau --help works
  // eslint-disable-next-line no-console
  console.error(`warning: failed to load user content: ${(err as Error).message}`);
  // eslint-disable-next-line no-console
  console.error("using built-in personas and prompts only.");
  // Import fallback built-ins
  const { personas: builtinPersonas } = await import("./personas.js");
  const { prompts: builtinPrompts } = await import("./prompts.js");
  personas = builtinPersonas;
  prompts = builtinPrompts;
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

const initialPersona = cli.personaId
  ? (personas.find((p) => p.id === cli.personaId) ?? personas[0]!)
  : personas[0]!;

if (cli.reasoningOverride !== undefined) {
  initialPersona.settings.reasoning = cli.reasoningOverride;
}

const initialUserMessage = await readPipedStdin();

const app = new ChatApp({
  personas,
  prompts,
  initialPersonaId: cli.personaId,
  initialUserMessage,
  initialRiskLevel: cli.riskLevel,
  withContext: cli.withContext,
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
