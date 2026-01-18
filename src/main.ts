#!/usr/bin/env node
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AuthPromptFn,
  BashCommand,
  CliOptions,
  Config,
  Persona,
  PromptTemplate,
  ReasoningEffort,
  Skill,
  ThemeDefinition,
} from "./core/index.js";
import {
  AuthStorage,
  buildVirtualBundle,
  CliError,
  createLocalToolExecutionBackend,
  createSandboxToolExecutionBackend,
  getAuthPath,
  loadConfig,
  loadRuntimeConfig,
  parseCliArgs,
  parsePersonaString,
  printDebugInfo,
  printHelp,
  runLoginCommand,
  runLogoutCommand,
  ToolCatalog,
} from "./core/index.js";
import { ChatApp } from "./tui/index.js";

const cwd = process.cwd();
const argv = process.argv.slice(2);

function registerTerminalExitCleanup(): void {
  if (!process.stdout.isTTY) return;
  process.on("exit", () => {
    try {
      writeSync(1, "\x1b[?25h\x1b[?2004l");
    } catch {
      // ignore
    }
  });
}

registerTerminalExitCleanup();

function printAuthHelp(): void {
  console.log(
    [
      "usage:",
      "  tau login [provider]",
      "  tau logout [provider]",
      "",
      "providers:",
      "  openai-codex  OpenAI Codex (ChatGPT Plus/Pro)",
      "",
      "examples:",
      "  tau login openai-codex",
      "  tau logout openai-codex",
    ].join("\n"),
  );
}

// Load configuration + content from file
let config: Config;
let bashCommands: BashCommand[] = [];

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
let themes: ThemeDefinition[] = [];

if (argv[0] === "login" || argv[0] === "logout") {
  if (argv.includes("--help") || argv.includes("-h")) {
    printAuthHelp();
    process.exit(0);
  }

  const authPath = getAuthPath();
  const authStorage = new AuthStorage(authPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt: AuthPromptFn = (question) =>
    new Promise((resolve) => {
      const suffix = question.placeholder ? ` (${question.placeholder})` : "";
      rl.question(`${question.message}${suffix} `, resolve);
    });

  try {
    if (argv[0] === "login") {
      await runLoginCommand({
        providerArg: argv[1],
        authStorage,
        authPath,
        prompt,
      });
    } else {
      await runLogoutCommand({
        providerArg: argv[1],
        authStorage,
        authPath,
        prompt,
      });
    }
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

function requireSandboxConfig(config: Config): NonNullable<Config["sandbox"]> {
  const sandbox = config.sandbox;
  if (!sandbox?.image) {
    // eslint-disable-next-line no-console
    console.error("--sandbox requires sandbox.image in config.json");
    process.exit(1);
  }
  return sandbox;
}

async function createSandboxBackend(config: Config) {
  try {
    return await createSandboxToolExecutionBackend({ config: requireSandboxConfig(config) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

try {
  const runtime = await loadRuntimeConfig(cwd);
  config = runtime.config;
  personas = runtime.personas;
  prompts = runtime.prompts;
  skills = runtime.skills;
  themes = runtime.themes;
  bashCommands = runtime.bashCommands;
} catch (err) {
  // Safeguard: loadRuntimeConfig should not throw, but wrap to ensure tau --help works
  // eslint-disable-next-line no-console
  console.error(`failed to load user content: ${(err as Error).message}`);

  config = loadConfig(cwd);
  bashCommands = config.bashCommands ?? [];

  const virtualBundle = buildVirtualBundle(config);
  const hasBuiltins =
    virtualBundle.personas.length > 0 ||
    virtualBundle.prompts.length > 0 ||
    virtualBundle.skills.length > 0 ||
    virtualBundle.themes.length > 0;

  // eslint-disable-next-line no-console
  console.error(
    hasBuiltins
      ? "using built-in resources only."
      : "no built-in resources available (built-ins disabled by config).",
  );

  personas = virtualBundle.personas;
  prompts = virtualBundle.prompts;
  skills = virtualBundle.skills;
  themes = virtualBundle.themes;
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

  const debugRiskLevel = cli.riskLevel ?? config.defaultRisk;
  const debugSandboxConfig = cli.sandbox ? requireSandboxConfig(config) : undefined;
  const debugBackend = cli.sandbox
    ? await createSandboxBackend(config)
    : { backend: createLocalToolExecutionBackend(), dispose: undefined };
  const virtualBundle = buildVirtualBundle(config);

  try {
    const debugToolRegistry = ToolCatalog.createRegistry(debugBackend.backend);
    printDebugInfo({
      personas,
      prompts,
      bashCommands,
      skills,
      virtualBundle,
      selectedPersona: debugPersona,
      noAgentContextFiles: cli.noAgentContextFiles,
      riskLevel: debugRiskLevel,
      sandboxConfig: debugSandboxConfig,
      sandboxInfo: debugSandboxConfig?.environmentInfo,
      toolRegistry: debugToolRegistry,
    });
    process.exit(0);
  } finally {
    await debugBackend.dispose?.();
  }
}

if (personas.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    "no personas available. add a custom persona in ~/.config/tau/personas or .tau/personas, or unset disableBuiltinPersonas.",
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

const sandboxBackend = cli.sandbox ? await createSandboxBackend(config) : undefined;

const app = new ChatApp({
  personas,
  prompts,
  skills,
  themes,
  bashCommands,
  initialPersonaId,
  initialUserMessage,
  initialRiskLevel,
  noAgentContextFiles: cli.noAgentContextFiles,
  config,
  sandboxEnabled: cli.sandbox,
  toolBackend: sandboxBackend?.backend,
  toolBackendDispose: sandboxBackend?.dispose,
});

let isShuttingDown = false;
const shutdown = async (code = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await app.stop();
  process.exit(code);
};

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
  await app.start();
} catch (err) {
  await app.stop();
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
