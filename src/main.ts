#!/usr/bin/env node
import { ChatApp } from "./app.js";
import type { CliOptions } from "./cli.js";
import { CliError, parseCliArgs, printHelp } from "./cli.js";
import { loadConfig } from "./config.js";
import { personas } from "./personas.js";
import { prompts } from "./prompts.js";

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

if (cli.reasoningSpecified) {
  if (cli.reasoningEffort) {
    initialPersona.settings.reasoning = cli.reasoningEffort;
  } else {
    delete (initialPersona.settings as { reasoning?: unknown }).reasoning;
  }
}

const initialUserMessage = await readPipedStdin();

const app = new ChatApp({
  personas,
  prompts,
  initialPersonaId: cli.personaId,
  initialUserMessage,
  initialToolAccessLevel: cli.toolAccessLevel,
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
