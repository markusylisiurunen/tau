import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import { CoreSession } from "../session/core_session.js";
import type { ResolveSubagentRuntime, ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { Persona, ReasoningEffort } from "../types.js";
import {
  type ConversationTurnResult,
  ConversationTurnRuntime,
} from "./conversation_turn_runtime.js";
import type { CoreDeps } from "./deps.js";
import { composeSessionPrompts, type SessionPromptComposition } from "./session_prompt_composer.js";

export type ChatRuntimePromptContext = {
  cwd: string;
  home: string;
  repoRoot?: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  includeAgentContext: boolean;
  projectContextBlock?: string;
  skillsBlock?: string;
};

export type ChatRuntimeEnvironment = {
  now: () => number;
};

export type ChatRuntimeOptions = {
  session: CoreSession;
  persona: Persona;
  promptContext: ChatRuntimePromptContext;
  environment: ChatRuntimeEnvironment;
  initialPromptComposition?: SessionPromptComposition;
};

export type CreateChatRuntimeOptions = {
  persona: Persona;
  toolRegistry: ToolRegistry;
  clientToolDefinitions?: (sessionId: string) => ToolDefinition[];
  modelResolver: ModelResolver;
  resolveSubagentRuntime?: ResolveSubagentRuntime;
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
  private promptContext: ChatRuntimePromptContext;
  private readonly environment: ChatRuntimeEnvironment;
  private latestPromptComposition: SessionPromptComposition;

  static create(options: CreateChatRuntimeOptions): ChatRuntime {
    const promptComposition =
      options.initialPromptComposition ??
      composeSessionPrompts({
        persona: options.persona,
        cwd: options.promptContext.cwd,
        repoRoot: options.promptContext.repoRoot,
        datetime: new Date(options.environment.now()).toISOString(),
        platform: options.promptContext.platform,
        nodeVersion: options.promptContext.nodeVersion,
        skillsBlock: options.promptContext.skillsBlock,
        projectContextBlock: options.promptContext.projectContextBlock,
      });

    const session = new CoreSession({
      persona: options.persona,
      systemPrompt: promptComposition.baseSystemPrompt,
      subagentPrompts: promptComposition.subagentPrompts,
      toolRegistry: options.toolRegistry,
      clientToolDefinitions: options.clientToolDefinitions,
      modelResolver: options.modelResolver,
      ...(options.resolveSubagentRuntime
        ? { resolveSubagentRuntime: options.resolveSubagentRuntime }
        : {}),
      config: options.config,
      deps: options.deps,
      cwd: options.promptContext.cwd,
      home: options.promptContext.home,
      includeAgentContext: options.promptContext.includeAgentContext,
    });

    return new ChatRuntime({
      session,
      persona: options.persona,
      promptContext: options.promptContext,
      environment: options.environment,
      initialPromptComposition: promptComposition,
    });
  }

  constructor(options: ChatRuntimeOptions) {
    this.sessionInstance = options.session;
    this.turnRuntime = new ConversationTurnRuntime(this.sessionInstance);
    this.currentPersona = options.persona;
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

  runTurn(
    options?: Parameters<ConversationTurnRuntime["run"]>[0],
  ): Promise<ConversationTurnResult> {
    return this.turnRuntime.run(options);
  }

  requestTurnBoundaryStop(): boolean {
    return this.turnRuntime.requestStopAtBoundary();
  }

  cancelTurnBoundaryStop(): boolean {
    return this.turnRuntime.cancelStopAtBoundary();
  }

  interruptTurn(): boolean {
    return this.turnRuntime.interrupt();
  }

  setRuntimeConfig(config: Config, modelResolver: ModelResolver): void {
    this.sessionInstance.setRuntimeConfig(config, modelResolver);
  }

  setReasoning(reasoning: ReasoningEffort): void {
    this.currentPersona = {
      ...this.currentPersona,
      settings: {
        ...this.currentPersona.settings,
        reasoning,
      },
    };
    this.sessionInstance.setReasoning(reasoning);
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

  private composePromptSet(skillsBlock?: string): SessionPromptComposition {
    return composeSessionPrompts({
      persona: this.currentPersona,
      cwd: this.promptContext.cwd,
      repoRoot: this.promptContext.repoRoot,
      datetime: new Date(this.environment.now()).toISOString(),
      platform: this.promptContext.platform,
      nodeVersion: this.promptContext.nodeVersion,
      skillsBlock: skillsBlock ?? this.promptContext.skillsBlock,
      projectContextBlock: this.promptContext.projectContextBlock,
    });
  }
}
