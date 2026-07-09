import type { CoreEvent } from "../events/types.js";
import type { CoreSession, ProcessTurnResult } from "../session/core_session.js";

export type ConversationTurnResult = ProcessTurnResult;

export class ConversationTurnRuntime {
  private readonly session: Pick<CoreSession, "events">;
  private abortController?: AbortController;
  private stopAtBoundaryRequested = false;

  constructor(session: Pick<CoreSession, "events">) {
    this.session = session;
  }

  get isRunning(): boolean {
    return this.abortController !== undefined;
  }

  async run(options?: {
    onEvent?: (event: CoreEvent) => void | Promise<void>;
  }): Promise<ConversationTurnResult> {
    if (this.abortController) {
      throw new Error("conversation turn is already running");
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      let result: ProcessTurnResult | undefined;
      let eventHandlerError: unknown;
      try {
        this.stopAtBoundaryRequested = false;
        const stream = this.session.events(abortController.signal, {
          shouldStopAtBoundary: () => this.stopAtBoundaryRequested,
        });
        while (true) {
          const next = await stream.next();
          if (next.done) {
            result = next.value;
            break;
          }

          try {
            await options?.onEvent?.(next.value);
          } catch (err) {
            eventHandlerError = err;
            abortController.abort();
            await stream.return?.({ aborted: true });
            break;
          }
          if (abortController.signal.aborted) {
            await stream.return?.({ aborted: true });
            break;
          }
        }
      } catch (err) {
        if (eventHandlerError !== undefined) {
          throw eventHandlerError;
        }
        if (!abortController.signal.aborted) {
          throw err;
        }
      }
      if (eventHandlerError !== undefined) {
        throw eventHandlerError;
      }

      return {
        aborted: abortController.signal.aborted || Boolean(result?.aborted),
        ...(result?.blocked ? { blocked: result.blocked } : {}),
      };
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined;
        this.stopAtBoundaryRequested = false;
      }
    }
  }

  requestStopAtBoundary(): boolean {
    if (!this.abortController) {
      return false;
    }
    this.stopAtBoundaryRequested = true;
    return true;
  }

  cancelStopAtBoundary(): boolean {
    if (!this.abortController || !this.stopAtBoundaryRequested) {
      return false;
    }
    this.stopAtBoundaryRequested = false;
    return true;
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
