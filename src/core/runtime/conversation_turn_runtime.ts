import type { CoreEvent } from "../events/types.js";
import type { CoreSession, ProcessTurnResult } from "../session/core_session.js";

export type ConversationTurnResult = ProcessTurnResult;

export class ConversationTurnRuntime {
  private readonly session: Pick<CoreSession, "events">;
  private abortController?: AbortController;

  constructor(session: Pick<CoreSession, "events">) {
    this.session = session;
  }

  get isRunning(): boolean {
    return this.abortController !== undefined;
  }

  async run(options?: { onEvent?: (event: CoreEvent) => void }): Promise<ConversationTurnResult> {
    if (this.abortController) {
      throw new Error("conversation turn is already running");
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      let result: ProcessTurnResult | undefined;
      try {
        const stream = this.session.events(abortController.signal);
        while (true) {
          const next = await stream.next();
          if (next.done) {
            result = next.value;
            break;
          }

          options?.onEvent?.(next.value);
          if (abortController.signal.aborted) {
            await stream.return?.({ aborted: true });
            break;
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          throw err;
        }
      }

      return {
        aborted: abortController.signal.aborted || Boolean(result?.aborted),
        ...(result?.blocked ? { blocked: result.blocked } : {}),
      };
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
    }
  }

  interrupt(): boolean {
    const abortController = this.abortController;
    if (!abortController || abortController.signal.aborted) {
      return false;
    }

    abortController.abort();
    return true;
  }
}
