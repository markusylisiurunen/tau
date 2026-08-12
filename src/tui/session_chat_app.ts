import { createInterface } from "node:readline/promises";
import { Type } from "typebox";
import { z } from "zod";
import { createCommandClientTools } from "../core/client_tools/command_client_tools.js";
import { createCommandRegistry } from "../core/commands/index.js";
import type {
  CommandClientToolConfig,
  Config,
  DiffToolConfig,
  ThemeDefinition,
} from "../core/config/index.js";
import { DIFF_REVIEW_TOOL, parseDiffReviewToolArgs } from "../core/diff_review/index.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import { TOOL_NAME_PREFILL_INPUT } from "../core/tools/tool_names.js";
import { formatZodError } from "../core/utils/zod.js";
import type { SessionProtocolCreateParams } from "../protocol/session_protocol.js";
import { truncateTauClientToolText } from "../sdk/client_tool_presentation.js";
import { createTauSdkClientFromTransport } from "../sdk/session.js";
import type { TauSdkClient, TauSdkClientTool, TauSdkSession } from "../sdk/types.js";
import { WebSocketSessionProtocolTransport } from "../transport/websocket_session_transport.js";
import { TuiChatView } from "./chat_view.js";
import { EXIT_DOUBLE_PRESS_WINDOW_MS, EXIT_TOAST_DURATION_MS } from "./constants.js";
import { SessionChatController } from "./session_chat_controller.js";
import type { TerminalColors } from "./terminal_appearance.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";

export type SessionChatAppOptions = {
  sessionSelection: SessionChatSelection;
  client: TauSdkClient;
  configuredClientToolNames: string[];
  targetLabel: string;
  terminalColors?: TerminalColors | Promise<TerminalColors>;
  themeId?: string;
  themes?: ThemeDefinition[];
  config?: Config;
  defaultDiffTool?: DiffToolConfig;
  deps?: CoreDeps;
  initialUserMessage?: string;
};

export type SessionChatTransportOptions = Omit<
  SessionChatAppOptions,
  "client" | "configuredClientToolNames" | "targetLabel"
> & {
  clientToolsEnabled: boolean;
  transport: "websocket";
  url: string;
  authToken?: string;
};

const prefillInputArgsSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "must contain non-whitespace text"),
  })
  .strict();

function createDiffReviewPresentation(args: unknown) {
  const parsed = parseDiffReviewToolArgs(args);
  return {
    subject: truncateTauClientToolText(parsed.ok ? parsed.data.command : parsed.command),
    subjectWrap: "character" as const,
  };
}

function createPrefillInputPresentation(args: unknown) {
  const parsed = prefillInputArgsSchema.safeParse(args);
  return {
    subject: truncateTauClientToolText(parsed.success ? parsed.data.text : TOOL_NAME_PREFILL_INPUT),
  };
}

export function createTuiClientTools(options: {
  enabled: boolean;
  getController: () => SessionChatController | undefined;
  commandTools?: CommandClientToolConfig[];
  deps?: Pick<CoreDeps, "spawn">;
}): TauSdkClientTool[] {
  if (!options.enabled) {
    return [];
  }

  const tools: TauSdkClientTool[] = [
    {
      schema: {
        ...DIFF_REVIEW_TOOL,
        executionTimeoutMs: 30 * 60 * 1000,
      },
      describe: (args) => createDiffReviewPresentation(args),
      execute: async (args, context) => {
        const controller = options.getController();
        if (!controller) {
          throw new Error("diff_review is unavailable because the TUI is not ready");
        }
        const content = await controller.runClientDiffReview(args, context);
        return { content, presentation: createDiffReviewPresentation(args) };
      },
    },
    {
      schema: {
        name: TOOL_NAME_PREFILL_INPUT,
        description: [
          "Prefill the user's TUI input editor with a draft for them to review, edit, and submit.",
          "Use this sparingly, only when an editable structured draft would save the user meaningful effort; respond normally for routine content.",
          "Use short, obvious placeholders such as [name] or [details] for information only the user can provide.",
          "This tool does not submit the input and fails without changing the editor when it already contains text.",
        ].join(" "),
        parameters: Type.Object(
          {
            text: Type.String({
              minLength: 1,
              pattern: "\\S",
              description: "Complete non-blank draft text to place in the empty input editor.",
            }),
          },
          { additionalProperties: false },
        ),
      },
      describe: (args) => createPrefillInputPresentation(args),
      execute: (args) => {
        const parsed = prefillInputArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid prefill_input arguments: ${formatZodError(parsed.error)}`);
        }
        const controller = options.getController();
        if (!controller) {
          throw new Error("prefill_input is unavailable because the TUI is not ready");
        }
        return {
          content: controller.prefillInput(parsed.data.text),
          presentation: createPrefillInputPresentation(args),
        };
      },
    },
  ];

  tools.push(...createCommandClientTools(options.commandTools ?? [], options.deps));

  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.schema.name)) {
      throw new Error(`duplicate TUI client tool '${tool.schema.name}'`);
    }
    names.add(tool.schema.name);
  }

  return tools;
}

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

export class SessionChatApp {
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
    let controller: SessionChatController | undefined;
    const clientTools = createTuiClientTools({
      enabled: options.clientToolsEnabled,
      getController: () => controller,
      commandTools: options.config?.clientTools,
      deps: options.deps,
    });
    const transport = new WebSocketSessionProtocolTransport({
      url: options.url,
      authToken: options.authToken,
    });
    const client = await createTauSdkClientFromTransport(transport, {
      initialize: { client: { name: "tau-tui", version: "1" } },
      clientTools,
    });
    const app = await SessionChatApp.open({
      ...options,
      client,
      configuredClientToolNames: options.clientToolsEnabled
        ? (options.config?.clientTools ?? []).map((tool) => tool.name)
        : [],
      targetLabel: options.url,
    });
    controller = app.controller;
    return app;
  }

  static async open(options: SessionChatAppOptions): Promise<SessionChatApp> {
    try {
      const [session, terminalColors] = await Promise.all([
        resolveSession(options.client, options.sessionSelection),
        options.terminalColors,
      ]);
      const snapshot = await session.snapshot();
      const view = new TuiChatView({
        showThinking: false,
        terminalColors,
        themeId: options.themeId,
        themes: options.themes ?? [],
      });
      let app: SessionChatApp;
      const controller = new SessionChatController({
        view,
        session,
        snapshot,
        createSession: (input) => options.client.sessions.create(input),
        targetLabel: options.targetLabel,
        configuredClientToolNames: options.configuredClientToolNames,
        config: options.config,
        defaultDiffTool: options.defaultDiffTool,
        deps: options.deps,
        themeIds: (options.themes ?? []).map((theme) => theme.id),
        onExit: () => app.exit(),
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
        ),
      );
      const handlers = controller.getInputHandlers();
      app = new SessionChatApp({
        view,
        controller,
        client: options.client,
        initialUserMessage: options.initialUserMessage,
      });
      handlers.onCtrlC = () => app.handleCtrlC();
      view.bindInputHandlers(handlers);
      return app;
    } catch (error) {
      await Promise.resolve(options.terminalColors).catch(() => undefined);
      await options.client.close();
      throw error;
    }
  }

  getController(): SessionChatController {
    return this.controller;
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

  private handleCtrlC(): void {
    const now = Date.now();
    if (this.lastCtrlCAt !== undefined && now - this.lastCtrlCAt <= EXIT_DOUBLE_PRESS_WINDOW_MS) {
      this.lastCtrlCAt = undefined;
      this.exit();
      return;
    }

    this.lastCtrlCAt = now;
    this.view.showFooterNotice("press ctrl+c again to quit", "default", EXIT_TOAST_DURATION_MS);
  }

  private exit(): void {
    void this.stop().finally(() => process.exit(0));
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
      attributes: { source: "tui" },
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
      attributes: { source: "tui" },
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
    attributes: { source: "tui" },
  });
}
