#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AuthPromptFn,
  BashCommand,
  Checkpoint,
  CliOptions,
  Config,
  Persona,
  PromptTemplate,
  ReasoningEffort,
  RiskLevel,
  RuntimeBootstrap,
  Skill,
  ThemeDefinition,
} from "./core/index.js";
import {
  AsyncCliError,
  AuthStorage,
  ChatRuntime,
  CliError,
  createDefaultConfigDeps,
  createDefaultCoreDeps,
  createLocalToolExecutionBackend,
  getAuthPath,
  InstallCliError,
  loadConfig,
  loadRuntimeBootstrap,
  loadRuntimeConfig,
  parseCheckpoint,
  parseCliArgs,
  parsePersonaString,
  printAsyncHelp,
  printDebugInfo,
  printDiffToolHelp,
  printHelp,
  printInstallHelp,
  printUsageHelp,
  resolveRuntimePromptBootstrap,
  runAsyncCommand,
  runInstallCommand,
  runListCommand,
  runLoginCommand,
  runLogoutCommand,
  runRpcServer,
  runToolCommand,
  runUsageCommand,
  ToolCatalog,
  ToolCliError,
  UsageCliError,
} from "./core/index.js";
import { getStartupPlatformError } from "./core/platform_support.js";
import { TOOL_NAME_DIFF_REVIEW } from "./core/tools/tool_names.js";
import {
  createBuiltInDiffToolConfig,
  DiffToolLaunchEnvironmentError,
  runBuiltInDiffToolCommand,
} from "./diff_tool/index.js";
import { ChatApp } from "./tui/index.js";
import { detectTerminalAppearance } from "./tui/terminal_appearance.js";

const cwd = process.cwd();
const configDeps = createDefaultConfigDeps();
const argv = process.argv.slice(2);
const isRpcSubcommand = argv[0] === "rpc";
const isDiffToolSubcommand = argv[0] === "diff-tool";

const startupPlatformError = getStartupPlatformError(process.platform);
if (startupPlatformError) {
  // eslint-disable-next-line no-console
  console.error(startupPlatformError);
  process.exit(1);
}

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

if (!isRpcSubcommand && !isDiffToolSubcommand) {
  registerTerminalExitCleanup();
}

function printAuthHelp(): void {
  console.log(
    [
      "usage:",
      "  tau auth login <provider>",
      "  tau auth list",
      "  tau auth logout <provider> --account <email>",
      "",
      "providers:",
      "  codex  OpenAI Codex (ChatGPT Plus/Pro)",
      "",
      "examples:",
      "  tau auth login codex",
      "  tau auth list",
      "  tau auth logout codex --account user@example.com",
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

function clonePersonaForSession(persona: Persona): Persona {
  return {
    ...persona,
    settings: { ...persona.settings },
    allowedReasoningLevels: persona.allowedReasoningLevels
      ? [...persona.allowedReasoningLevels]
      : undefined,
  };
}

function omitTuiOnlyTools(persona: Persona): Persona {
  return {
    ...persona,
    tools: persona.tools?.filter((tool) => tool !== TOOL_NAME_DIFF_REVIEW),
  };
}

async function runRpcMode(options: {
  cli: CliOptions;
  config: Config;
  persona: Persona;
  riskLevel: RiskLevel;
  skills: Skill[];
  history?: Checkpoint["history"];
}): Promise<void> {
  const deps = createDefaultCoreDeps();
  const persona = omitTuiOnlyTools(options.persona);
  const runtimeCwd = deps.env.cwd();
  const home = deps.env.home() || process.env.HOME || homedir();
  const bootstrap = resolveRuntimePromptBootstrap({
    persona,
    discoveredSkills: options.skills,
    cwd: runtimeCwd,
    home,
    includeAgentContext: !options.cli.noAgentContextFiles,
    readFile: (path) => readFileSync(path, "utf-8"),
  });

  if (bootstrap.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.error("config warnings:");
    for (const warning of bootstrap.warnings) {
      // eslint-disable-next-line no-console
      console.error(`- ${warning}`);
    }
    // eslint-disable-next-line no-console
    console.error("");
  }

  const runtime = ChatRuntime.create({
    persona,
    riskLevel: options.riskLevel,
    toolRegistry: ToolCatalog.createRegistry(createLocalToolExecutionBackend()),
    promptContext: bootstrap.promptContext,
    environment: {
      now: () => deps.clock.now(),
      platform: () => deps.env.platform(),
      nodeVersion: () => deps.env.nodeVersion(),
    },
    config: options.config,
    deps,
  });

  for (const message of options.history ?? []) {
    runtime.session.addMessage(message);
  }

  const abortController = new AbortController();
  const requestShutdown = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  const onSigInt = () => requestShutdown();
  const onSigTerm = () => requestShutdown();

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    await runRpcServer({
      runtime,
      input: process.stdin,
      output: process.stdout,
      signal: abortController.signal,
    });
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

// Load built-in and user content
let personas: Persona[];
let prompts: PromptTemplate[];
let skills: Skill[];
let themes: ThemeDefinition[] = [];
let runtimeBootstrap: RuntimeBootstrap | undefined;

if (argv[0] === "auth") {
  if (argv.includes("--help") || argv.includes("-h")) {
    printAuthHelp();
    process.exit(0);
  }

  const subcommand = argv[1];
  const providerArg = argv[2];
  const accountIndex = argv.indexOf("--account");
  const accountId = accountIndex >= 0 ? argv[accountIndex + 1] : undefined;

  const authPath = getAuthPath();
  const authStorage = new AuthStorage(authPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt: AuthPromptFn = (question) =>
    new Promise((resolve) => {
      const suffix = question.placeholder ? ` (${question.placeholder})` : "";
      rl.question(`${question.message}${suffix} `, resolve);
    });

  try {
    if (subcommand === "login") {
      await runLoginCommand({
        providerArg,
        authStorage,
        authPath,
        prompt,
      });
    } else if (subcommand === "logout") {
      await runLogoutCommand({
        providerArg,
        accountId,
        authStorage,
        authPath,
        prompt,
      });
    } else if (subcommand === "list") {
      await runListCommand({ authStorage });
    } else {
      throw new Error(`unknown auth subcommand "${subcommand ?? ""}"`);
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

if (argv[0] === "usage") {
  try {
    await runUsageCommand(argv.slice(1));
    process.exit(0);
  } catch (err) {
    if (err instanceof UsageCliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printUsageHelp();
      process.exit(1);
    }
    throw err;
  }
}

if (argv[0] === "install") {
  try {
    await runInstallCommand(argv.slice(1), {
      cwd,
      home: process.env.HOME,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof InstallCliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printInstallHelp();
      process.exit(1);
    }
    throw err;
  }
}

if (argv[0] === "async") {
  try {
    const asyncConfig = loadConfig(cwd, configDeps);
    await runAsyncCommand(argv.slice(1), {
      cwd,
      env: process.env,
      config: asyncConfig,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof AsyncCliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printAsyncHelp();
      process.exit(1);
    }
    throw err;
  }
}

if (argv[0] === "tool") {
  try {
    const toolConfig = loadConfig(cwd, configDeps);
    await runToolCommand(argv.slice(1), {
      cwd,
      env: process.env,
      config: toolConfig,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof ToolCliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      if (err.helpPrinter) {
        // eslint-disable-next-line no-console
        console.error("");
        err.helpPrinter();
      }
      process.exit(1);
    }
    throw err;
  }
}

if (isDiffToolSubcommand) {
  const diffToolArgs = argv.slice(1);
  if (diffToolArgs.length > 0) {
    const wantsHelp = diffToolArgs.includes("--help") || diffToolArgs.includes("-h");
    if (wantsHelp) {
      printDiffToolHelp();
      process.exit(0);
    }

    // eslint-disable-next-line no-console
    console.error(`unknown option: ${diffToolArgs[0]}`);
    // eslint-disable-next-line no-console
    console.error("");
    printDiffToolHelp();
    process.exit(1);
  }

  try {
    await runBuiltInDiffToolCommand();
    process.exit(0);
  } catch (err) {
    if (err instanceof DiffToolLaunchEnvironmentError) {
      // eslint-disable-next-line no-console
      console.error("tau diff-tool must be launched by Tau during /diff.");
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printDiffToolHelp();
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

try {
  const runtime = await loadRuntimeConfig(cwd, configDeps);
  runtimeBootstrap = runtime.bootstrap;
  config = runtime.config;
  personas = runtime.personas;
  prompts = runtime.prompts;
  skills = runtime.skills;
  themes = runtime.themes;
  bashCommands = runtime.bashCommands;
  if (runtime.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.error("config warnings:");
    for (const warning of runtime.warnings) {
      // eslint-disable-next-line no-console
      console.error(`- ${warning}`);
    }
    // eslint-disable-next-line no-console
    console.error("");
  }
} catch (err) {
  // Safeguard: loadRuntimeConfig should not throw, but wrap to ensure tau --help works
  // eslint-disable-next-line no-console
  console.error(`failed to load user content: ${(err as Error).message}`);

  runtimeBootstrap = loadRuntimeBootstrap(cwd, configDeps);
  config = runtimeBootstrap.config;
  bashCommands = config.bashCommands ?? [];

  const { virtualBundle } = runtimeBootstrap;
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

const cliArgv = isRpcSubcommand ? argv.slice(1) : argv;

let cli: CliOptions;
try {
  cli = parseCliArgs(cliArgv, personas);
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

if (isRpcSubcommand && cli.caffeinated) {
  // eslint-disable-next-line no-console
  console.error("--caffeinated is only supported in TUI mode.");
  process.exit(1);
}

let checkpointPersonaId: string | undefined;
let checkpointReasoning: ReasoningEffort | undefined;
let checkpointRiskLevel: Checkpoint["riskLevel"] | undefined;
let checkpointHistory: Checkpoint["history"] | undefined;

if (cli.loadPath) {
  const checkpointPath = resolve(cwd, cli.loadPath);
  let checkpoint: Checkpoint;
  try {
    const raw = await readFile(checkpointPath, "utf8");
    checkpoint = parseCheckpoint(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`failed to load checkpoint: ${(err as Error).message}`);
    process.exit(1);
  }

  const parsedPersona = parsePersonaString(checkpoint.personaId, personas);
  checkpointPersonaId = parsedPersona.personaId;
  if (!checkpointPersonaId) {
    // eslint-disable-next-line no-console
    console.error(
      `checkpoint persona '${checkpoint.personaId}' not found. falling back to default persona.`,
    );
  }
  checkpointReasoning = checkpoint.reasoning;
  checkpointRiskLevel = checkpoint.riskLevel;
  checkpointHistory = checkpoint.history;
}

let initialPersonaId: string | undefined;
let reasoningOverride: ReasoningEffort | undefined = cli.reasoningOverride;

if (cli.personaId) {
  initialPersonaId = cli.personaId;
} else if (checkpointPersonaId) {
  initialPersonaId = checkpointPersonaId;
  if (reasoningOverride === undefined && checkpointReasoning !== undefined) {
    reasoningOverride = checkpointReasoning;
  }
} else if (config.defaultPersona) {
  const parsedDefaultPersona = parsePersonaString(config.defaultPersona, personas);
  initialPersonaId = parsedDefaultPersona.personaId;
  if (
    reasoningOverride === undefined &&
    parsedDefaultPersona.personaId !== undefined &&
    parsedDefaultPersona.reasoning !== undefined
  ) {
    reasoningOverride = parsedDefaultPersona.reasoning;
  }
}

const initialRiskLevel = cli.riskLevel ?? checkpointRiskLevel ?? config.defaultRisk;

if (cli.debug) {
  let debugPersona: Persona | undefined;
  if (personas.length > 0) {
    const selectedPersona = initialPersonaId
      ? (personas.find((p) => p.id === initialPersonaId) ?? personas[0]!)
      : personas[0]!;
    debugPersona = clonePersonaForSession(selectedPersona);

    if (reasoningOverride !== undefined) {
      debugPersona.settings.reasoning = reasoningOverride;
    }
  }

  const debugRiskLevel = initialRiskLevel;
  const virtualBundle = runtimeBootstrap?.virtualBundle;
  const debugToolRegistry = ToolCatalog.createRegistry(createLocalToolExecutionBackend());
  printDebugInfo({
    personas,
    prompts,
    bashCommands,
    skills,
    virtualBundle,
    selectedPersona: debugPersona,
    noAgentContextFiles: cli.noAgentContextFiles,
    riskLevel: debugRiskLevel,
    toolRegistry: debugToolRegistry,
  });
  process.exit(0);
}

if (personas.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    "no personas available. add a custom persona in ~/.config/tau/personas or .tau/personas, or unset disableBuiltinPersonas.",
  );
  process.exit(1);
}

const initialPersonaBase = initialPersonaId
  ? (personas.find((p) => p.id === initialPersonaId) ?? personas[0]!)
  : personas[0]!;
const initialPersona = clonePersonaForSession(initialPersonaBase);

if (reasoningOverride !== undefined) {
  initialPersona.settings.reasoning = reasoningOverride;
}

const effectiveRiskLevel: RiskLevel = initialRiskLevel ?? "read-only";

if (isRpcSubcommand) {
  try {
    await runRpcMode({
      cli,
      config,
      persona: initialPersona,
      riskLevel: effectiveRiskLevel,
      skills,
      history: checkpointHistory,
    });
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

const initialUserMessage = await readPipedStdin();

const terminalAppearance = await detectTerminalAppearance();
const defaultDiffTool = createBuiltInDiffToolConfig({
  nodeExecutablePath: process.execPath,
  cliEntryPath: fileURLToPath(import.meta.url),
});

const app = new ChatApp({
  personas,
  prompts,
  skills,
  themes,
  bashCommands,
  terminalAppearance,
  initialPersonaId,
  initialReasoningOverride: reasoningOverride,
  initialUserMessage,
  initialRiskLevel: effectiveRiskLevel,
  initialHistory: checkpointHistory,
  noAgentContextFiles: cli.noAgentContextFiles,
  config,
  defaultDiffTool,
  caffeinated: cli.caffeinated,
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
