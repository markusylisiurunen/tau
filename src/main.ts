#!/usr/bin/env node
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AuthCliCommand, AuthPromptFn } from "./core/auth/cli.js";
import type { CliOptions } from "./core/cli.js";
import {
  CliError,
  parseCliArgs,
  parsePersonaString,
  printDiffToolHelp,
  printHelp,
} from "./core/cli.js";
import type { ThemeDefinition } from "./core/config/content_loader.js";
import { createDefaultConfigDeps } from "./core/config/deps.js";
import type { RuntimeBootstrap, RuntimeConfigResult } from "./core/config/runtime.js";
import { loadRuntimeBootstrap, loadRuntimeConfig } from "./core/config/runtime.js";
import type { Config } from "./core/config/schema.js";
import { loadConfig } from "./core/config/schema.js";
import { getStartupPlatformError } from "./core/platform_support.js";
import type { PromptTemplate } from "./core/prompts.js";
import { createDefaultCoreDeps } from "./core/runtime/deps.js";
import { createLocalToolExecutionBackend } from "./core/tools/execution_backend.js";
import type { Persona, ReasoningEffort, Skill } from "./core/types.js";
import { createBuiltInDiffToolConfig } from "./diff_tool/launcher.js";
import { CompositeExecutionEnvironmentResolver } from "./execution/execution_environment.js";
import { LocalExecutionEnvironmentResolver } from "./execution/local_execution_environment.js";
import { LocalSessionHost } from "./host/local_session_host.js";
import type {
  SessionProtocolCreateParams,
  SessionProtocolExecutionEnvironmentInput,
} from "./protocol/session_protocol.js";
import { createTauSdkClient } from "./sdk/client.js";
import { createTauSdkClientWithHostConfig } from "./sdk/local_client.js";
import { FileSessionStore, getDefaultSessionStoreDirectory } from "./store/file_session_store.js";
import { createTuiClientTools, SessionChatApp } from "./tui/index.js";
import { detectTerminalAppearance } from "./tui/terminal_appearance.js";

const cwd = process.cwd();
const configDeps = createDefaultConfigDeps();
const argv = process.argv.slice(2);
const isRpcSubcommand = argv[0] === "rpc";
const isAttachSubcommand = argv[0] === "attach";
const isServeSubcommand = argv[0] === "serve";
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

type AttachCliOptions = {
  help: boolean;
  sessionId?: string;
  createNew: boolean;
  cwd?: string;
  executionKind?: SessionProtocolExecutionEnvironmentInput["kind"];
  cloudflareBridgeId?: string;
  cloudflareSandboxId?: string;
  flyApiId?: string;
  flySpriteName?: string;
  target?: AttachTarget;
  authToken?: string;
  noClientTools: boolean;
};

type AttachTarget =
  | {
      transport: "stdio";
      command: string[];
    }
  | {
      transport: "websocket";
      url: string;
    };

type ServeCliOptions = {
  help: boolean;
  hostname: string;
  port: number;
  authToken?: string;
  cliArgs: string[];
};

function parseAttachArgs(args: string[]): AttachCliOptions {
  let help = false;
  let sessionId: string | undefined;
  let createNew = false;
  let cwd: string | undefined;
  let executionKind: SessionProtocolExecutionEnvironmentInput["kind"] | undefined;
  let cloudflareBridgeId: string | undefined;
  let cloudflareSandboxId: string | undefined;
  let flyApiId: string | undefined;
  let flySpriteName: string | undefined;
  let authToken: string | undefined;
  let target: AttachTarget | undefined;
  let noClientTools = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      target = { transport: "stdio", command: args.slice(i + 1) };
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--session" || arg.startsWith("--session=")) {
      const parsed = parseAttachValue(arg, args, i);
      sessionId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--new") {
      createNew = true;
      continue;
    }
    if (arg === "--no-client-tools") {
      noClientTools = true;
      continue;
    }
    if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const parsed = parseAttachValue(arg, args, i);
      cwd = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--execution-kind" || arg.startsWith("--execution-kind=")) {
      const parsed = parseAttachValue(arg, args, i);
      if (
        parsed.value !== "local" &&
        parsed.value !== "cloudflare-sandbox" &&
        parsed.value !== "fly-sprite"
      ) {
        throw new CliError("--execution-kind must be local, cloudflare-sandbox, or fly-sprite");
      }
      executionKind = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--cloudflare-bridge" || arg.startsWith("--cloudflare-bridge=")) {
      const parsed = parseAttachValue(arg, args, i);
      cloudflareBridgeId = parsed.value;
      executionKind ??= "cloudflare-sandbox";
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--cloudflare-sandbox" || arg.startsWith("--cloudflare-sandbox=")) {
      const parsed = parseAttachValue(arg, args, i);
      cloudflareSandboxId = parsed.value;
      executionKind ??= "cloudflare-sandbox";
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--fly-api" || arg.startsWith("--fly-api=")) {
      const parsed = parseAttachValue(arg, args, i);
      flyApiId = parsed.value;
      executionKind ??= "fly-sprite";
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--fly-sprite" || arg.startsWith("--fly-sprite=")) {
      const parsed = parseAttachValue(arg, args, i);
      flySpriteName = parsed.value;
      executionKind ??= "fly-sprite";
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--auth-token" || arg.startsWith("--auth-token=")) {
      const parsed = parseAttachValue(arg, args, i);
      authToken = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (isWebSocketUrl(arg)) {
      target = { transport: "websocket", url: arg };
      if (i !== args.length - 1) {
        throw new CliError("websocket attach target does not accept trailing arguments");
      }
      break;
    }
    throw new CliError(`unknown attach option: ${arg}`);
  }

  if (!help && !target) {
    throw new CliError("missing attach target");
  }

  if (target?.transport === "stdio" && target.command.length === 0) {
    throw new CliError("missing attach command after --");
  }

  if (sessionId !== undefined && createNew) {
    throw new CliError("--session and --new cannot be used together");
  }

  if (!help && createNew && !cwd) {
    throw new CliError("--new requires --cwd <absolute-path>");
  }

  if (!help && createNew && cwd && !isAbsolute(cwd)) {
    throw new CliError("--new requires --cwd <absolute-path>");
  }

  if (!help && createNew) {
    const kind = executionKind ?? "local";
    if (kind === "cloudflare-sandbox" && (!cloudflareBridgeId || !cloudflareSandboxId)) {
      throw new CliError(
        "--new --execution-kind cloudflare-sandbox requires --cloudflare-bridge and --cloudflare-sandbox",
      );
    }
    if (kind === "fly-sprite" && (!flyApiId || !flySpriteName)) {
      throw new CliError("--new --execution-kind fly-sprite requires --fly-api and --fly-sprite");
    }
  }

  return {
    help,
    sessionId,
    createNew,
    cwd,
    executionKind,
    cloudflareBridgeId,
    cloudflareSandboxId,
    flyApiId,
    flySpriteName,
    target,
    authToken,
    noClientTools,
  };
}

function parseServeArgs(args: string[]): ServeCliOptions {
  let help = false;
  let hostname = "127.0.0.1";
  let port = 8787;
  let authToken: string | undefined;
  const cliArgs: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = parseAttachValue(arg, args, i);
      hostname = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const parsed = parseAttachValue(arg, args, i);
      port = parsePort(parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--auth-token" || arg.startsWith("--auth-token=")) {
      const parsed = parseAttachValue(arg, args, i);
      authToken = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    cliArgs.push(arg);
  }

  return { help, hostname, port, authToken, cliArgs };
}

function parseAttachValue(
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

function buildAttachCreateInput(attach: AttachCliOptions): SessionProtocolCreateParams {
  const cwd = attach.cwd;
  if (!cwd) {
    throw new CliError("--new requires --cwd <absolute-path>");
  }

  const kind = attach.executionKind ?? "local";
  switch (kind) {
    case "local":
      return { executionEnvironment: { kind: "local", cwd } };
    case "cloudflare-sandbox":
      if (!attach.cloudflareBridgeId || !attach.cloudflareSandboxId) {
        throw new CliError(
          "--new --execution-kind cloudflare-sandbox requires --cloudflare-bridge and --cloudflare-sandbox",
        );
      }
      return {
        executionEnvironment: {
          kind: "cloudflare-sandbox",
          bridgeId: attach.cloudflareBridgeId,
          sandboxId: attach.cloudflareSandboxId,
          cwd,
        },
      };
    case "fly-sprite":
      if (!attach.flyApiId || !attach.flySpriteName) {
        throw new CliError("--new --execution-kind fly-sprite requires --fly-api and --fly-sprite");
      }
      return {
        executionEnvironment: {
          kind: "fly-sprite",
          apiId: attach.flyApiId,
          spriteName: attach.flySpriteName,
          cwd,
        },
      };
  }
}

function printAttachHelp(): void {
  console.log(
    [
      "tau attach - terminal TUI over a session protocol transport",
      "",
      "usage:",
      "  tau attach [--session <id> | --new --cwd <path> [execution options]] [--auth-token <token>] ws://host:port",
      "  tau attach [--session <id> | --new --cwd <path> [execution options]] -- <command> [args...]",
      "",
      "options:",
      "  --session <id>                 attach to an existing hosted session.",
      "  --new                          create and attach to a new hosted session.",
      "  --cwd <path>                   absolute cwd for a new session's execution environment.",
      "  --execution-kind <kind>        local, cloudflare-sandbox, or fly-sprite. default: local.",
      "  --cloudflare-bridge <id>       configured Cloudflare Sandbox bridge id.",
      "  --cloudflare-sandbox <id>      already-provisioned Cloudflare sandbox id.",
      "  --fly-api <id>                 configured Fly Sprites API id.",
      "  --fly-sprite <name>            already-provisioned Fly Sprite name.",
      "  --auth-token <token>           token for websocket servers started with --auth-token.",
      "  --no-client-tools              disable TUI client tools such as diff review and input prefill.",
      "  --help, -h                     show this help and exit.",
      "",
      "examples:",
      "  tau attach ws://127.0.0.1:8787",
      "  tau attach --new --cwd /srv/workspaces/repo ws://127.0.0.1:8787",
      "  tau attach --new --execution-kind cloudflare-sandbox --cloudflare-bridge default --cloudflare-sandbox sandbox-1 --cwd /workspace/repo ws://127.0.0.1:8787",
      "  tau attach --new --execution-kind fly-sprite --fly-api default --fly-sprite sprite-1 --cwd /home/sprite/repo ws://127.0.0.1:8787",
      "  tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 --auth-token $TAU_WS_AUTH_TOKEN ws://vps:8787",
      "",
      "without --session or --new, attach lists hosted sessions and prompts for a selection.",
      "stdio commands and websocket servers both speak Tau's session protocol.",
    ].join("\n"),
  );
}

function printServeHelp(): void {
  console.log(
    [
      "tau serve - host Tau sessions over WebSocket",
      "",
      "usage:",
      "  tau serve [--host <host>] [--port <port>] [--auth-token <token>] [options]",
      "",
      "options:",
      "  --host <host>        bind hostname or address. default: 127.0.0.1",
      "  --port <port>        bind TCP port. default: 8787",
      "  --auth-token <token> require tau attach / SDK websocket clients to provide this token.",
      "  --help, -h           show this help and exit.",
      "",
      "examples:",
      "  tau serve",
      "  tau serve --host 0.0.0.0 --port 8787 --auth-token $TAU_WS_AUTH_TOKEN",
    ].join("\n"),
  );
}

function isWebSocketUrl(value: string): boolean {
  return value.startsWith("ws://") || value.startsWith("wss://");
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`invalid port: ${value}`);
  }
  return port;
}

// Load configuration + content from file
let config: Config;

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

async function resolveHostedSessionBootstrap(options: {
  cli: CliOptions;
  runtime: RuntimeConfigResult;
  cwd: string;
}): Promise<{
  persona: Persona;
  discoveredSkills: Skill[];
  personas: Persona[];
  prompts: RuntimeConfigResult["prompts"];
  modelResolver: RuntimeConfigResult["bootstrap"]["modelResolver"]["resolveModel"];
  config: Config;
}> {
  const runtime = options.runtime;
  if (runtime.personas.length === 0) {
    throw new Error(
      `no personas available for execution environment cwd '${options.cwd}'. add a custom persona or enable built-ins.`,
    );
  }

  let personaId = options.cli.personaId;
  let reasoningOverride = options.cli.reasoningOverride;
  if (!personaId && runtime.config.defaultPersona) {
    const parsedDefaultPersona = parsePersonaString(
      runtime.config.defaultPersona,
      runtime.personas,
    );
    personaId = parsedDefaultPersona.personaId;
    if (reasoningOverride === undefined && parsedDefaultPersona.reasoning !== undefined) {
      reasoningOverride = parsedDefaultPersona.reasoning;
    }
  }

  const personaBase = personaId
    ? runtime.personas.find((persona) => persona.id === personaId)
    : runtime.personas[0];
  if (!personaBase) {
    throw new Error(
      `persona '${personaId}' is not available for execution environment cwd '${options.cwd}'`,
    );
  }

  const persona = clonePersonaForSession(personaBase);
  if (reasoningOverride !== undefined) {
    persona.settings.reasoning = reasoningOverride;
  }

  return {
    persona,
    discoveredSkills: runtime.skills,
    personas: runtime.personas.map(clonePersonaForSession),
    prompts: runtime.prompts,
    modelResolver: runtime.bootstrap.modelResolver.resolveModel,
    config: runtime.config,
  };
}

async function createLocalSessionHost(options: {
  cli: CliOptions;
  config: Config;
}): Promise<LocalSessionHost> {
  const deps = createDefaultCoreDeps();
  const home = deps.env.home() || process.env.HOME || homedir();
  const toolBackend = createLocalToolExecutionBackend();
  const localExecutionEnvironmentResolver = new LocalExecutionEnvironmentResolver({
    home,
    toolBackend,
  });
  const resolvers: ConstructorParameters<typeof CompositeExecutionEnvironmentResolver>[0] = {
    local: localExecutionEnvironmentResolver,
  };

  if (options.config.cloudflareSandbox?.bridges) {
    const { CloudflareSandboxExecutionEnvironmentResolver } = await import(
      "./execution/cloudflare_sandbox_execution_environment.js"
    );
    resolvers["cloudflare-sandbox"] = new CloudflareSandboxExecutionEnvironmentResolver({
      bridges: options.config.cloudflareSandbox.bridges,
    });
  }
  if (options.config.flySprites?.apis) {
    const { FlySpriteExecutionEnvironmentResolver } = await import(
      "./execution/fly_sprite_execution_environment.js"
    );
    resolvers["fly-sprite"] = new FlySpriteExecutionEnvironmentResolver({
      apis: options.config.flySprites.apis,
    });
  }

  return new LocalSessionHost({
    store: new FileSessionStore({ directory: getDefaultSessionStoreDirectory(home) }),
    executionEnvironmentResolver: new CompositeExecutionEnvironmentResolver(resolvers),
    includeAgentContext: !options.cli.noAgentContextFiles,
    environment: {
      now: () => deps.clock.now(),
    },
    deps,
    resolveSessionBootstrap: async ({ executionEnvironment }) => {
      const snapshot = executionEnvironment.snapshot();
      const runtime = await executionEnvironment.resolveRuntimeConfig(snapshot.cwd);
      return await resolveHostedSessionBootstrap({
        cli: options.cli,
        runtime,
        cwd: snapshot.cwd,
      });
    },
  });
}

async function runRpcMode(options: { cli: CliOptions; config: Config }): Promise<void> {
  const [sessionHost, { runRpcServer }] = await Promise.all([
    createLocalSessionHost(options),
    import("./core/modes/rpc_server.js"),
  ]);

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
      host: sessionHost,
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
  const {
    AuthStorage,
    getAuthPath,
    parseAuthCliArgs,
    runListCommand,
    runLoginCommand,
    runLogoutCommand,
  } = await import("./core/auth/index.js");
  let command: AuthCliCommand;
  try {
    command = parseAuthCliArgs(argv.slice(1));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }

  if (command.type === "help") {
    printAuthHelp();
    process.exit(0);
  }

  const authPath = getAuthPath();
  const authStorage = new AuthStorage(authPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));
  const prompt: AuthPromptFn = async (question) => {
    if (question.type === "select") {
      console.log(question.message);
      question.options.forEach((option, index) => {
        console.log(`  ${index + 1}. ${option.label}`);
      });
      const answer = await ask(`enter number (1-${question.options.length}): `);
      const option = question.options[Number.parseInt(answer, 10) - 1];
      if (!option) {
        throw new Error("invalid selection.");
      }
      return option.id;
    }

    const suffix = question.placeholder ? ` (${question.placeholder})` : "";
    return ask(`${question.message}${suffix} `);
  };

  try {
    if (command.type === "login") {
      await runLoginCommand({
        providerArg: command.providerArg,
        authStorage,
        authPath,
        prompt,
      });
    } else if (command.type === "logout") {
      await runLogoutCommand({
        providerArg: command.providerArg,
        accountId: command.accountId,
        authStorage,
        authPath,
        prompt,
      });
    } else {
      await runListCommand({ authStorage });
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
  const { printUsageHelp, runUsageCommand, UsageCliError } = await import("./core/usage/cli.js");
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
  const { InstallCliError, printInstallHelp, runInstallCommand } = await import(
    "./core/install/cli.js"
  );
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

if (argv[0] === "nook") {
  const { NookCliError, printNookHelp, runNookCommand } = await import("./core/nook/index.js");
  try {
    const nookConfig = loadConfig(cwd, configDeps);
    await runNookCommand(argv.slice(1), {
      cwd,
      env: process.env,
      config: nookConfig,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof NookCliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printNookHelp();
      process.exit(1);
    }
    throw err;
  }
}

if (argv[0] === "telegram") {
  const { printTelegramHelp, runTelegramCommand, TelegramCliError } = await import(
    "./core/telegram/index.js"
  );
  try {
    const telegramConfig = loadConfig(cwd, configDeps);
    await runTelegramCommand(argv.slice(1), {
      cwd,
      env: process.env,
      config: telegramConfig,
      createSessionClient: createTauSdkClient,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof TelegramCliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printTelegramHelp();
      process.exit(1);
    }
    throw err;
  }
}

if (argv[0] === "tool") {
  const { runToolCommand, ToolCliError } = await import("./core/tool/cli.js");
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
  const { DiffToolLaunchEnvironmentError, runBuiltInDiffToolCommand } = await import(
    "./diff_tool/index.js"
  );
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
      console.error("tau diff-tool must be launched with a Tau diff-review session environment.");
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

if (isAttachSubcommand) {
  let attach: AttachCliOptions;
  try {
    attach = parseAttachArgs(argv.slice(1));
  } catch (err) {
    if (err instanceof CliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printAttachHelp();
      process.exit(1);
    }
    throw err;
  }

  if (attach.help) {
    printAttachHelp();
    process.exit(0);
  }

  if (!attach.target) {
    throw new Error("missing attach target");
  }

  const terminalAppearance = await detectTerminalAppearance();
  const defaultDiffTool = createBuiltInDiffToolConfig({
    nodeExecutablePath: process.execPath,
    cliEntryPath: fileURLToPath(import.meta.url),
    codeTheme: config.builtInDiffTool?.codeTheme,
  });
  const sessionSelection = attach.sessionId
    ? ({ mode: "attach", sessionId: attach.sessionId } as const)
    : attach.createNew
      ? ({
          mode: "create",
          input: buildAttachCreateInput(attach),
        } as const)
      : ({ mode: "select" } as const);
  const app =
    attach.target.transport === "stdio"
      ? await SessionChatApp.connect({
          transport: "stdio",
          command: attach.target.command[0]!,
          args: attach.target.command.slice(1),
          sessionSelection,
          terminalAppearance,
          themeId: config.defaultTheme,
          themes,
          config,
          defaultDiffTool,
          clientToolsEnabled: !attach.noClientTools,
        })
      : await SessionChatApp.connect({
          transport: "websocket",
          url: attach.target.url,
          authToken: attach.authToken ?? process.env.TAU_WS_AUTH_TOKEN,
          sessionSelection,
          terminalAppearance,
          themeId: config.defaultTheme,
          themes,
          config,
          defaultDiffTool,
          clientToolsEnabled: !attach.noClientTools,
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
    await new Promise<void>(() => undefined);
  } catch (err) {
    await app.stop();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
}

let serve: ServeCliOptions | undefined;
if (isServeSubcommand) {
  try {
    serve = parseServeArgs(argv.slice(1));
  } catch (err) {
    if (err instanceof CliError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      // eslint-disable-next-line no-console
      console.error("");
      printServeHelp();
      process.exit(1);
    }
    throw err;
  }

  if (serve.help) {
    printServeHelp();
    process.exit(0);
  }
}

const cliArgv = isRpcSubcommand ? argv.slice(1) : isServeSubcommand ? serve!.cliArgs : argv;

let cli: CliOptions;
try {
  cli = parseCliArgs(cliArgv);
  if (
    !isRpcSubcommand &&
    !isServeSubcommand &&
    cli.personaId &&
    !personas.some((persona) => persona.id === cli.personaId)
  ) {
    throw new CliError(
      `unknown persona '${cli.personaId}'. available personas: ${personas.map((persona) => persona.id).join(", ")}`,
    );
  }
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

if ((isRpcSubcommand || isServeSubcommand) && cli.debug) {
  // eslint-disable-next-line no-console
  console.error("--debug is only supported in TUI mode.");
  process.exit(1);
}

if (isRpcSubcommand && cli.caffeinated) {
  // eslint-disable-next-line no-console
  console.error("--caffeinated is only supported in TUI mode.");
  process.exit(1);
}

if (isServeSubcommand && cli.caffeinated) {
  // eslint-disable-next-line no-console
  console.error("--caffeinated is only supported in TUI mode.");
  process.exit(1);
}

if ((isRpcSubcommand || isServeSubcommand) && cli.noClientTools) {
  // eslint-disable-next-line no-console
  console.error("--no-client-tools is only supported in TUI mode.");
  process.exit(1);
}

let initialPersonaId: string | undefined;
let reasoningOverride: ReasoningEffort | undefined = cli.reasoningOverride;

if (cli.personaId) {
  initialPersonaId = cli.personaId;
} else if (!isRpcSubcommand && !isServeSubcommand && config.defaultPersona) {
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

if (cli.debug) {
  const [
    { printDebugInfo },
    { resolveRuntimePromptBootstrap },
    { ToolCatalog },
    { createLocalToolExecutionBackend },
    { ToolRegistry },
  ] = await Promise.all([
    import("./core/debug.js"),
    import("./core/runtime/runtime_bootstrap.js"),
    import("./core/tools/catalog.js"),
    import("./core/tools/execution_backend.js"),
    import("./core/tools/registry.js"),
  ]);
  const selectedPersona = initialPersonaId
    ? personas.find((persona) => persona.id === initialPersonaId)
    : personas[0];
  const debugPersona = selectedPersona ? clonePersonaForSession(selectedPersona) : undefined;
  if (debugPersona && reasoningOverride !== undefined) {
    debugPersona.settings.reasoning = reasoningOverride;
  }

  const virtualBundle = runtimeBootstrap?.virtualBundle;
  const debugDeps = createDefaultCoreDeps();
  const debugBackend = createLocalToolExecutionBackend();
  const debugPromptBootstrap = debugPersona
    ? await resolveRuntimePromptBootstrap({
        persona: debugPersona,
        discoveredSkills: skills,
        cwd,
        home: debugDeps.env.home() || process.env.HOME || homedir(),
        includeAgentContext: !cli.noAgentContextFiles,
        agentContextFiles: config.agentContextFiles ?? [],
        backend: debugBackend,
      })
    : undefined;
  const debugToolRegistry =
    debugPersona && runtimeBootstrap
      ? ToolCatalog.createDebugRegistry({
          backend: debugBackend,
          cwd,
          config,
          persona: debugPersona,
          modelResolver: runtimeBootstrap.modelResolver.resolveModel,
        })
      : new ToolRegistry([]);
  printDebugInfo({
    personas,
    prompts,
    skills,
    virtualBundle,
    selection:
      debugPersona && debugPromptBootstrap
        ? { persona: debugPersona, promptContext: debugPromptBootstrap.promptContext }
        : undefined,
    cwd,
    datetime: new Date(debugDeps.clock.now()).toISOString(),
    toolRegistry: debugToolRegistry,
  });
  process.exit(0);
}

if (isServeSubcommand) {
  const [sessionHost, { runWebSocketSessionServer }] = await Promise.all([
    createLocalSessionHost({ cli, config }),
    import("./core/modes/websocket_server.js"),
  ]);

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
    await runWebSocketSessionServer({
      host: sessionHost,
      hostname: serve!.hostname,
      port: serve!.port,
      authToken: serve!.authToken ?? process.env.TAU_WS_AUTH_TOKEN,
      signal: abortController.signal,
      onListening: (address) => {
        // eslint-disable-next-line no-console
        console.error(`tau websocket server listening on ws://${address.hostname}:${address.port}`);
      },
    });
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

if (isRpcSubcommand) {
  try {
    await runRpcMode({ cli, config });
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (personas.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    "no personas available. add a custom persona in ~/.config/tau/personas or .tau/personas, or unset disableBuiltinPersonas.",
  );
  process.exit(1);
}

const initialUserMessage = await readPipedStdin();

const terminalAppearance = detectTerminalAppearance();
const defaultDiffTool = createBuiltInDiffToolConfig({
  nodeExecutablePath: process.execPath,
  cliEntryPath: fileURLToPath(import.meta.url),
  codeTheme: config.builtInDiffTool?.codeTheme,
});

let sessionChatApp: SessionChatApp | undefined;
const sessionClient = await createTauSdkClientWithHostConfig(
  {
    cwd,
    persona: initialPersonaId,
    reasoning: reasoningOverride,
    noAgentContextFiles: cli.noAgentContextFiles,
    initialize: { client: { name: "tau-tui", version: "1" } },
    clientTools: createTuiClientTools({
      enabled: !cli.noClientTools,
      getController: () => sessionChatApp?.getController(),
    }),
  },
  config,
);
const app = await SessionChatApp.open({
  client: sessionClient,
  targetLabel: "in-process",
  sessionSelection: {
    mode: "create",
    input: {
      executionEnvironment: { kind: "local", cwd },
      ...(initialPersonaId !== undefined ? { personaId: initialPersonaId } : {}),
      ...(reasoningOverride !== undefined ? { reasoning: reasoningOverride } : {}),
    },
  },
  themes,
  terminalAppearance,
  themeId: config.defaultTheme,
  initialUserMessage,
  config,
  defaultDiffTool,
  caffeinated: cli.caffeinated,
});
sessionChatApp = app;

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
