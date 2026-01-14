import type { CoreEvent } from "../events/types.js";
import { serializeCoreEvent } from "../events/types.js";
import type { ModeAdapter } from "./mode_adapter.js";

export type RpcAdapterOptions = {
  send?: (payload: string) => void;
};

export class RpcAdapter implements ModeAdapter {
  private readonly send: (payload: string) => void;

  constructor(options: RpcAdapterOptions = {}) {
    this.send = options.send ?? (() => {});
  }

  onEvent(event: CoreEvent): void {
    this.send(serializeCoreEvent(event));
  }

  onUserInput(): void {
    // rpc input handling will be wired up in a future task
  }

  onInterrupt(): void {
    // rpc interruption will be wired up in a future task
  }
}
