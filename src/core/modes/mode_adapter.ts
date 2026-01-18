import type { CoreEvent } from "../events/types.js";

export interface ModeAdapter {
  onEvent(event: CoreEvent): void | Promise<void>;
  onUserInput(text: string): void | Promise<void>;
  onInterrupt(): void;
}
