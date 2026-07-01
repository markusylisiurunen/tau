import { spawn as spawnProcess } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { createCommandRegistry } from "../core/commands/index.js";
import type {
  Config,
  DiffToolConfig,
  ThemeAppearance,
  ThemeDefinition,
} from "../core/config/index.js";
import type { ModeAdapter } from "../core/modes/mode_adapter.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { SessionProtocolCreateParams } from "../protocol/session_protocol.js";
import { createTauSdkClientFromTransport } from "../sdk/session.js";
import type { TauSdkClient, TauSdkSession } from "../sdk/types.js";
import { StdioSessionProtocolTransport } from "../transport/stdio_session_transport.js";
import { WebSocketSessionProtocolTransport } from "../transport/websocket_session_transport.js";
import { TuiChatView } from "./chat_view.js";
import { EXIT_DOUBLE_PRESS_WINDOW_MS, EXIT_TOAST_DURATION_MS } from "./constants.js";
import { SessionChatController } from "./session_chat_controller.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";

export type SessionChatAppOptions = {
  sessionSelection: SessionChatSelection;
  client: TauSdkClient;
  targetLabel: string;
  terminalAppearance?: ThemeAppearance;
  themeId?: string;
  themes?: ThemeDefinition[];
  config?: Config;
  defaultDiffTool?: DiffToolConfig;
  deps?: CoreDeps;
  initialUserMessage?: string;
  caffeinated?: boolean;
};

export type SessionChatTransportOptions = Omit<SessionChatAppOptions, "client" | "targetLabel"> &
  (
    | {
        transport: "stdio";
        command: string;
        args: string[];
      }
    | {
        transport: "websocket";
        url: string;
        authToken?: string;
      }
  );

export type SessionChatSelection =
  | {
      mode: "attach";
      sessionId: string;
    }
  | {
      mode: "create";
      input: SessionProtocolCreateParams;
    }
  | {
      mode: "select";
    };

export class SessionChatApp implements ModeAdapter {
  private readonly view: TuiChatView;
  private readonly controller: SessionChatController;
  private readonly client: TauSdkClient;
  private readonly initialUserMessage?: string;
  private lastCtrlCAt?: number;

  private constructor(options: {
    view: TuiChatView;
    controller: SessionChatController;
    client: TauSdkClient;
    initialUserMessage?: string;
  }) {
    this.view = options.view;
    this.controller = options.controller;
    this.client = options.client;
    this.initialUserMessage = options.initialUserMessage;
  }

  static async connect(options: SessionChatTransportOptions): Promise<SessionChatApp> {
    const transport =
      options.transport === "stdio"
        ? new StdioSessionProtocolTransport(
            spawnProcess(options.command, options.args, {
              stdio: "pipe",
            }),
          )
        : new WebSocketSessionProtocolTransport({
            url: options.url,
            authToken: options.authToken,
          });
    const client = await createTauSdkClientFromTransport(transport, {
      initialize: { client: { name: "tau-tui", version: "1" } },
    });
    return await SessionChatApp.open({
      ...options,
      client,
      targetLabel:
        options.transport === "stdio" ? [options.command, ...options.args].join(" ") : options.url,
    });
  }

  static async open(options: SessionChatAppOptions): Promise<SessionChatApp> {
    try {
      const session = await resolveSession(options.client, options.sessionSelection);
      const snapshot = await session.snapshot();
      const queuedUserMessages: string[] = [];
      const view = new TuiChatView({
        queuedUserMessages,
        compactToolUi: true,
        showThinking: false,
        terminalAppearance: options.terminalAppearance,
        themeId: options.themeId,
        themes: options.themes ?? [],
      });
      const controller = new SessionChatController({
        view,
        session,
        snapshot,
        createSession: (input) => options.client.sessions.create(input),
        targetLabel: options.targetLabel,
        config: options.config,
        defaultDiffTool: options.defaultDiffTool,
        deps: options.deps,
        queuedUserMessages,
        caffeinated: options.caffeinated,
        themeIds: (options.themes ?? []).map((theme) => theme.id),
      });
      const sources = controller.getAutocompleteSources();
      view.setAutocompleteProvider(
        new SlashAutocompleteProvider(
          createCommandRegistry(),
          sources.personas,
          sources.prompts,
          sources.themes,
          async (query, limit, signal) => {
            if (signal.aborted) return [];
            return await sources.autocompletePaths(query, limit);
          },
          sources.skills,
          sources.subagents,
          sources.riskLevels,
        ),
      );
      const handlers = controller.getInputHandlers();
      const app = new SessionChatApp({
        view,
        controller,
        client: options.client,
        initialUserMessage: options.initialUserMessage,
      });
      handlers.onCtrlC = () => app.handleCtrlC();
      view.bindInputHandlers(handlers);
      return app;
    } catch (error) {
      await options.client.close();
      throw error;
    }
  }

  async start(): Promise<void> {
    this.view.start();
    this.controller.start();
    if (this.initialUserMessage) {
      await this.controller.onUserInput(this.initialUserMessage);
    }
  }

  async stop(): Promise<void> {
    this.view.stop();
    try {
      await this.controller.dispose();
    } finally {
      await this.client.close();
    }
  }

  async onUserInput(text: string): Promise<void> {
    await this.controller.onUserInput(text);
  }

  onInterrupt(): void {
    const handlers = this.controller.getInputHandlers();
    handlers.onEscape?.();
  }

  onEvent(): void {}

  private handleCtrlC(): void {
    const now = Date.now();
    if (this.lastCtrlCAt !== undefined && now - this.lastCtrlCAt <= EXIT_DOUBLE_PRESS_WINDOW_MS) {
      this.lastCtrlCAt = undefined;
      void this.stop().finally(() => process.exit(0));
      return;
    }

    this.lastCtrlCAt = now;
    this.view.addSystemMessage("press ctrl+c again to quit", "warn", {
      toastDurationMs: EXIT_TOAST_DURATION_MS,
    });
  }
}

async function resolveSession(
  client: TauSdkClient,
  selection: SessionChatSelection,
): Promise<TauSdkSession> {
  switch (selection.mode) {
    case "attach":
      return await client.sessions.observe(selection.sessionId);
    case "create":
      return await client.sessions.create(selection.input);
    case "select":
      return await selectSession(client);
  }
}

async function selectSession(client: TauSdkClient): Promise<TauSdkSession> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("attach requires --session or --new when stdin/stdout are not a TTY");
  }

  const sessions = await client.sessions.list();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (sessions.length === 0) {
      const answer = (await rl.question("no hosted sessions found. create a new session? [y/N] "))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") {
        return await createSessionFromPrompt(client, rl);
      }
      throw new Error("no session selected");
    }

    console.log("hosted sessions:");
    sessions.forEach((session, index) => {
      console.log(`  ${index + 1}. ${session.sessionId} (${session.lifecycle})`);
    });
    console.log("  n. create new session");

    const answer = (await rl.question("select session number/id, or n for new: ")).trim();
    if (answer === "n" || answer === "new") {
      return await createSessionFromPrompt(client, rl);
    }

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
      return await client.sessions.observe(sessions[index - 1]!.sessionId);
    }

    if (answer.length > 0) {
      return await client.sessions.observe(answer);
    }

    throw new Error("no session selected");
  } finally {
    rl.close();
  }
}

async function createSessionFromPrompt(
  client: TauSdkClient,
  rl: ReturnType<typeof createInterface>,
): Promise<TauSdkSession> {
  const rawKind = (
    await rl.question("execution kind [local/cloudflare-sandbox/fly-sprite, default local]: ")
  )
    .trim()
    .toLowerCase();
  const kind =
    rawKind === ""
      ? "local"
      : rawKind === "local" || rawKind === "cloudflare-sandbox" || rawKind === "fly-sprite"
        ? rawKind
        : undefined;
  if (!kind) {
    throw new Error("execution kind must be local, cloudflare-sandbox, or fly-sprite");
  }

  const cwd = (await rl.question("execution cwd: ")).trim();
  if (!cwd) {
    throw new Error("execution cwd is required");
  }

  if (kind === "local") {
    return await client.sessions.create({
      executionEnvironment: {
        kind,
        cwd,
      },
    });
  }

  if (kind === "cloudflare-sandbox") {
    const bridgeId = (await rl.question("Cloudflare bridge id: ")).trim();
    const sandboxId = (await rl.question("Cloudflare sandbox id: ")).trim();
    if (!bridgeId || !sandboxId) {
      throw new Error("Cloudflare bridge id and sandbox id are required");
    }
    return await client.sessions.create({
      executionEnvironment: {
        kind,
        bridgeId,
        sandboxId,
        cwd,
      },
    });
  }

  const apiId = (await rl.question("Fly API id: ")).trim();
  const spriteName = (await rl.question("Fly Sprite name: ")).trim();
  if (!apiId || !spriteName) {
    throw new Error("Fly API id and Sprite name are required");
  }
  return await client.sessions.create({
    executionEnvironment: {
      kind,
      apiId,
      spriteName,
      cwd,
    },
  });
}
