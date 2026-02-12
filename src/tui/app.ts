import type { Message } from "@mariozechner/pi-ai";
import type {
  BashCommand,
  Config,
  ThemeAppearance,
  ThemeDefinition,
} from "../core/config/index.js";
import type { CoreEvent } from "../core/events/types.js";
import type { ModeAdapter } from "../core/modes/mode_adapter.js";
import type { PromptTemplate } from "../core/prompts.js";
import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import type { Persona, RiskLevel, Skill } from "../core/types.js";
import { ChatController } from "./chat_controller.js";
import { TuiChatView } from "./chat_view.js";
import { EXIT_DOUBLE_PRESS_WINDOW_MS, EXIT_TOAST_DURATION_MS } from "./constants.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";

export interface ChatAppOptions {
  personas: Persona[];
  prompts?: PromptTemplate[];
  skills?: Skill[];
  themes?: ThemeDefinition[];
  bashCommands?: BashCommand[];
  terminalAppearance?: ThemeAppearance;
  initialPersonaId?: string;
  initialUserMessage?: string;
  initialRiskLevel?: RiskLevel;
  initialHistory?: Message[];
  noAgentContextFiles?: boolean;
  config?: Config;
  sandboxEnabled?: boolean;
  toolBackend?: ToolExecutionBackend;
  toolBackendDispose?: () => Promise<void> | void;
}

export class ChatApp implements ModeAdapter {
  private readonly view: TuiChatView;
  private readonly controller: ChatController;
  private lastCtrlCAt?: number;

  constructor(options: ChatAppOptions) {
    const queuedUserMessages: string[] = [];
    this.view = new TuiChatView({
      queuedUserMessages,
      compactToolUi: true,
      showThinking: false,
      terminalAppearance: options.terminalAppearance,
      themeId: options.config?.defaultTheme,
      themes: options.themes ?? [],
    });

    this.controller = new ChatController({
      ...options,
      view: this.view,
      queuedUserMessages,
    });

    const handlers = this.controller.getInputHandlers();
    handlers.onCtrlC = () => {
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
    };
    this.view.bindInputHandlers(handlers);

    const sources = this.controller.getAutocompleteSources();
    this.view.setAutocompleteProvider(
      new SlashAutocompleteProvider(
        this.controller.getCommandRegistry(),
        sources.personas,
        sources.prompts,
        sources.themes,
        sources.bashCommands,
        sources.projectFiles,
        sources.skills,
        sources.subagents,
        sources.riskLevels,
      ),
    );
  }

  async start(): Promise<void> {
    this.view.start();
    await this.controller.start();
  }

  async stop(): Promise<void> {
    this.view.stop();
    try {
      await this.controller.dispose();
    } catch {
      // best-effort cleanup
    }
  }

  public async onUserInput(text: string): Promise<void> {
    await this.controller.onUserInput(text);
  }

  public onInterrupt(): void {
    this.controller.onInterrupt();
  }

  public onEvent(event: CoreEvent): void {
    this.controller.onEvent(event);
  }
}
