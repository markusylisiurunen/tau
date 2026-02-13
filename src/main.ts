#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
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
  Skill,
  ThemeDefinition,
} from "./core/index.js";
import {
  AsyncCliError,
  AuthStorage,
  buildVirtualBundle,
  ChatRuntime,
  CliError,
  createDefaultCoreDeps,
  createLocalToolExecutionBackend,
  createSandboxToolExecutionBackend,
  getAuthPath,
  InstallCliError,
  loadConfig,
  loadRuntimeConfig,
  parseCheckpoint,
  parseCliArgs,
  parsePersonaString,
  printAsyncHelp,
  printDebugInfo,
  printHelp,
  printInstallHelp,
  printUsageHelp,
  runAsyncCommand,
  runInstallCommand,
  runListCommand,
  runLoginCommand,
  runLogoutCommand,
  runRpcServer,
  runUsageCommand,
  ToolCatalog,
  UsageCliError,
} from "./core/index.js";
import { getStartupPlatformError } from "./core/platform_support.js";
import { resolveAgentCwd } from "./core/utils/agent_environment.js";
import {
  buildProjectContextBlock,
  buildSkillsIndexBlock,
  findAgentsFilesInScopeDetailed,
} from "./core/utils/context.js";
import { ChatApp } from "./tui/index.js";
import { detectTerminalAppearance } from "./tui/terminal_appearance.js";

const cwd = process.cwd();
const argv = process.argv.slice(2);
const isRpcSubcommand = argv[0] === "rpc";

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

if (!isRpcSubcommand) {
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

function getEnabledSkillsForPersona(persona: Persona, discoveredSkills: Skill[]): Skill[] {
  const personaSkills = persona.skills;
  if (personaSkills === "*") {
    return discoveredSkills;
  }

  if (!personaSkills || personaSkills.length === 0) {
    return [];
  }

  const byName = new Map<string, Skill>();
  for (const skill of discoveredSkills) {
    byName.set(skill.name.toLowerCase(), skill);
  }

  const enabled: Skill[] = [];
  for (const name of personaSkills) {
    const skill = byName.get(name.trim().toLowerCase());
    if (skill) {
      enabled.push(skill);
    }
  }

  return enabled;
}

async function runRpcMode(options: {
  cli: CliOptions;
  config: Config;
  persona: Persona;
  riskLevel: RiskLevel;
  skills: Skill[];
  history?: Checkpoint["history"];
}): Promise<void> {
  const sandboxBackend = options.cli.sandbox
    ? await createSandboxBackend(options.config)
    : undefined;

  try {
    const deps = createDefaultCoreDeps();
    const runtimeCwd = deps.env.cwd();
    const home = deps.env.home() || process.env.HOME || homedir();
    const includeAgentContext = !options.cli.noAgentContextFiles;

    let projectContextBlock: string | undefined;
    if (includeAgentContext) {
      const agentsContext = findAgentsFilesInScopeDetailed(runtimeCwd, home);
      if (agentsContext.errors.length > 0) {
        // eslint-disable-next-line no-console
        console.error("config warnings:");
        for (const warning of agentsContext.errors) {
          // eslint-disable-next-line no-console
          console.error(`- ${warning}`);
        }
        // eslint-disable-next-line no-console
        console.error("");
      }

      projectContextBlock = buildProjectContextBlock({
        cwd: runtimeCwd,
        home,
        agentsFiles: agentsContext.files,
        readFile: (path) => readFileSync(path, "utf-8"),
      });
    }

    const runtime = ChatRuntime.create({
      persona: options.persona,
      riskLevel: options.riskLevel,
      toolRegistry: ToolCatalog.createRegistry(
        sandboxBackend?.backend ?? createLocalToolExecutionBackend(),
      ),
      promptContext: {
        cwd: resolveAgentCwd({
          cwd: runtimeCwd,
          sandboxEnabled: options.cli.sandbox,
          sandboxConfig: options.config.sandbox,
        }),
        projectContextBlock,
        sandboxEnabled: options.cli.sandbox,
        sandboxEnvironmentInfo: options.config.sandbox?.environmentInfo,
        skillsBlock: buildSkillsIndexBlock(
          getEnabledSkillsForPersona(options.persona, options.skills),
        ),
      },
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
  } finally {
    await sandboxBackend?.dispose?.();
  }
}

// Load built-in and user content
let personas: Persona[];
let prompts: PromptTemplate[];
let skills: Skill[];
let themes: ThemeDefinition[] = [];

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
    const asyncConfig = loadConfig(cwd);
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
  const parsed = parsePersonaString(config.defaultPersona, personas);
  initialPersonaId = parsed.personaId;
  if (reasoningOverride === undefined) {
    reasoningOverride = parsed.reasoning;
  }
}

const initialRiskLevel = cli.riskLevel ?? checkpointRiskLevel ?? config.defaultRisk;

if (cli.debug) {
  let debugPersona: Persona | undefined;
  if (personas.length > 0) {
    debugPersona = initialPersonaId
      ? (personas.find((p) => p.id === initialPersonaId) ?? personas[0]!)
      : personas[0]!;

    if (reasoningOverride !== undefined) {
      debugPersona.settings.reasoning = reasoningOverride;
    }
  }

  const debugRiskLevel = initialRiskLevel;
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

const initialPersona = initialPersonaId
  ? (personas.find((p) => p.id === initialPersonaId) ?? personas[0]!)
  : personas[0]!;

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

const sandboxBackend = cli.sandbox ? await createSandboxBackend(config) : undefined;
const terminalAppearance = await detectTerminalAppearance();

const app = new ChatApp({
  personas,
  prompts,
  skills,
  themes,
  bashCommands,
  terminalAppearance,
  initialPersonaId,
  initialUserMessage,
  initialRiskLevel: effectiveRiskLevel,
  initialHistory: checkpointHistory,
  noAgentContextFiles: cli.noAgentContextFiles,
  config,
  sandboxEnabled: cli.sandbox,
  caffeinated: cli.caffeinated,
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
