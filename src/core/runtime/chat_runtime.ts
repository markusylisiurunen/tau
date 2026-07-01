import type { Config } from "../config/index.js";
import { CoreSession } from "../session/core_session.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import {
  type ConversationTurnResult,
  ConversationTurnRuntime,
} from "./conversation_turn_runtime.js";
import type { CoreDeps } from "./deps.js";
import { composeSessionPrompts, type SessionPromptComposition } from "./session_prompt_composer.js";

export type ChatRuntimePromptContext = {
  cwd: string;
  home?: string;
  includeAgentContext?: boolean;
  projectContextBlock?: string;
  skillsBlock?: string;
};

export type ChatRuntimeEnvironment = {
  now: () => number;
  platform: () => NodeJS.Platform;
  nodeVersion: () => string;
};

export type ChatRuntimeOptions = {
  session: CoreSession;
  persona: Persona;
  riskLevel: RiskLevel;
  promptContext: ChatRuntimePromptContext;
  environment: ChatRuntimeEnvironment;
  initialPromptComposition?: SessionPromptComposition;
};

export type CreateChatRuntimeOptions = {
  persona: Persona;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
  promptContext: ChatRuntimePromptContext;
  environment: ChatRuntimeEnvironment;
  initialPromptComposition?: SessionPromptComposition;
  config?: Config;
  deps?: CoreDeps;
};

export class ChatRuntime {
  private readonly sessionInstance: CoreSession;
  private readonly turnRuntime: ConversationTurnRuntime;
  private currentPersona: Persona;
  private riskLevel: RiskLevel;
  private promptContext: ChatRuntimePromptContext;
  private readonly environment: ChatRuntimeEnvironment;
  private latestPromptComposition: SessionPromptComposition;

  static create(options: CreateChatRuntimeOptions): ChatRuntime {
    const promptComposition =
      options.initialPromptComposition ??
      composeSessionPrompts({
        persona: options.persona,
        riskLevel: options.riskLevel,
        cwd: options.promptContext.cwd,
        datetime: new Date(options.environment.now()).toISOString(),
        platform: options.environment.platform(),
        nodeVersion: options.environment.nodeVersion(),
        skillsBlock: options.promptContext.skillsBlock,
        projectContextBlock: options.promptContext.projectContextBlock,
      });

    const session = new CoreSession({
      persona: options.persona,
      systemPrompt: promptComposition.baseSystemPrompt,
      subagentPrompts: promptComposition.subagentPrompts,
      riskLevel: options.riskLevel,
      toolRegistry: options.toolRegistry,
      config: options.config,
      deps: options.deps,
      cwd: options.promptContext.cwd,
      home: options.promptContext.home,
      includeAgentContext: options.promptContext.includeAgentContext,
    });

    return new ChatRuntime({
      session,
      persona: options.persona,
      riskLevel: options.riskLevel,
      promptContext: options.promptContext,
      environment: options.environment,
      initialPromptComposition: promptComposition,
    });
  }

  constructor(options: ChatRuntimeOptions) {
    this.sessionInstance = options.session;
    this.turnRuntime = new ConversationTurnRuntime(this.sessionInstance);
    this.currentPersona = options.persona;
    this.riskLevel = options.riskLevel;
    this.promptContext = { ...options.promptContext };
    this.environment = options.environment;

    this.latestPromptComposition = options.initialPromptComposition ?? this.composePromptSet();

    if (!options.initialPromptComposition) {
      this.sessionInstance.setPersona(
        this.currentPersona,
        this.latestPromptComposition.baseSystemPrompt,
        this.latestPromptComposition.subagentPrompts,
      );
    }
  }

  get session(): CoreSession {
    return this.sessionInstance;
  }

  get isTurnRunning(): boolean {
    return this.turnRuntime.isRunning;
  }

  get promptComposition(): SessionPromptComposition {
    return this.latestPromptComposition;
  }

  get persona(): Persona {
    return this.currentPersona;
  }

  get currentRiskLevel(): RiskLevel {
    return this.riskLevel;
  }

  runTurn(
    options?: Parameters<ConversationTurnRuntime["run"]>[0],
  ): Promise<ConversationTurnResult> {
    return this.turnRuntime.run(options);
  }

  requestTurnBoundaryStop(): boolean {
    return this.turnRuntime.requestStopAtBoundary();
  }

  interruptTurn(): boolean {
    return this.turnRuntime.interrupt();
  }

  setConfig(config: Config): void {
    this.sessionInstance.setConfig(config);
  }

  setRiskLevel(level: RiskLevel): void {
    const previous = this.riskLevel;
    this.riskLevel = level;
    this.sessionInstance.setRiskLevel(level);

    if (previous !== level) {
      this.rebuildSubagentPrompts();
    }
  }

  setPersona(persona: Persona, options?: { skillsBlock?: string }): void {
    this.currentPersona = persona;
    this.rebuildSystemPrompts(options);
  }

  updatePromptContext(context: Partial<ChatRuntimePromptContext>): void {
    this.promptContext = {
      ...this.promptContext,
      ...context,
    };
    this.sessionInstance.setPromptContext({
      cwd: this.promptContext.cwd,
      home: this.promptContext.home,
      includeAgentContext: this.promptContext.includeAgentContext,
    });
  }

  rebuildSystemPrompts(options?: { skillsBlock?: string }): void {
    if (options?.skillsBlock !== undefined) {
      this.promptContext.skillsBlock = options.skillsBlock;
    }

    this.latestPromptComposition = this.composePromptSet(options?.skillsBlock);
    this.sessionInstance.setPersona(
      this.currentPersona,
      this.latestPromptComposition.baseSystemPrompt,
      this.latestPromptComposition.subagentPrompts,
    );
  }

  rebuildSubagentPrompts(options?: { skillsBlock?: string }): void {
    if (options?.skillsBlock !== undefined) {
      this.promptContext.skillsBlock = options.skillsBlock;
    }

    const nextPromptComposition = this.composePromptSet(options?.skillsBlock);
    this.latestPromptComposition = {
      ...this.latestPromptComposition,
      subagentPrompts: nextPromptComposition.subagentPrompts,
    };

    this.sessionInstance.setPersona(
      this.currentPersona,
      this.latestPromptComposition.baseSystemPrompt,
      this.latestPromptComposition.subagentPrompts,
    );
  }

  private composePromptSet(skillsBlock?: string): SessionPromptComposition {
    return composeSessionPrompts({
      persona: this.currentPersona,
      riskLevel: this.riskLevel,
      cwd: this.promptContext.cwd,
      datetime: new Date(this.environment.now()).toISOString(),
      platform: this.environment.platform(),
      nodeVersion: this.environment.nodeVersion(),
      skillsBlock: skillsBlock ?? this.promptContext.skillsBlock,
      projectContextBlock: this.promptContext.projectContextBlock,
    });
  }
}
