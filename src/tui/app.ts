import type { BashCommand, Config, ThemeDefinition } from "../core/config/index.js";
import type { CoreEvent } from "../core/events/types.js";
import type { ModeAdapter } from "../core/modes/mode_adapter.js";
import type { PromptTemplate } from "../core/prompts.js";
import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import type { Persona, RiskLevel, Skill } from "../core/types.js";
import { ChatController } from "./chat_controller.js";
import { TuiChatView } from "./chat_view.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";

export interface ChatAppOptions {
  personas: Persona[];
  prompts?: PromptTemplate[];
  skills?: Skill[];
  themes?: ThemeDefinition[];
  bashCommands?: BashCommand[];
  initialPersonaId?: string;
  initialUserMessage?: string;
  initialRiskLevel?: RiskLevel;
  noAgentContextFiles?: boolean;
  config?: Config;
  sandboxEnabled?: boolean;
  toolBackend?: ToolExecutionBackend;
  toolBackendDispose?: () => Promise<void> | void;
}

export class ChatApp implements ModeAdapter {
  private readonly view: TuiChatView;
  private readonly controller: ChatController;

  constructor(options: ChatAppOptions) {
    const queuedUserMessages: string[] = [];
    this.view = new TuiChatView({
      queuedUserMessages,
      compactToolUi: true,
      showThinking: false,
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
      void this.stop().finally(() => process.exit(0));
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
