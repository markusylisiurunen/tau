import type { Message } from "@mariozechner/pi-ai";
import type { Config } from "../config/index.js";
import type { CoreEvent } from "../events/types.js";
import type { CoreDeps } from "../runtime/deps.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { SessionEngine } from "./session_engine.js";

export type { CoreEvent };

export type CoreSessionOptions = {
  persona: Persona;
  systemPrompt: string;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
  config?: Config;
  deps?: CoreDeps;
};

export class CoreSession {
  private readonly engine: SessionEngine;

  constructor(options: CoreSessionOptions) {
    this.engine = new SessionEngine(options);
  }

  reset(): void {
    this.engine.reset();
  }

  setPersona(persona: Persona, systemPrompt: string): void {
    this.engine.setPersona(persona, systemPrompt);
  }

  setRiskLevel(level: RiskLevel): void {
    this.engine.setRiskLevel(level);
  }

  setConfig(config: Config): void {
    this.engine.setConfig(config);
  }

  addUserText(textForModel: string): void {
    this.engine.addUserText(textForModel);
  }

  addMessage(message: Message): void {
    this.engine.addMessage(message);
  }

  get history(): readonly Message[] {
    return this.engine.history;
  }

  async *events(signal: AbortSignal): AsyncGenerator<CoreEvent> {
    yield* this.engine.processTurn(signal);
  }
}
