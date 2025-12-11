#!/usr/bin/env node
import { ChatApp } from "./app.js";
import type { CliOptions } from "./cli.js";
import { CliError, parseCliArgs, printHelp } from "./cli.js";
import { personas } from "./personas.js";

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

const app = new ChatApp({ personas, initialPersonaId: cli.personaId });

try {
  await app.start();
} catch (err) {
  app.stop();
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
