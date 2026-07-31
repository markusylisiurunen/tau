import type { AgentEvent } from "../agent/events.js";

export interface ModeAdapter {
  onEvent(event: AgentEvent): void | Promise<void>;
  onUserInput(text: string): void | Promise<void>;
  onInterrupt(): void;
}
