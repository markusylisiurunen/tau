import type { CoreSession } from "../session/core_session.js";

export type ConversationTurnResult = {
  aborted: boolean;
};

export class ConversationTurnRuntime {
  private readonly session: Pick<CoreSession, "events">;
  private abortController?: AbortController;

  constructor(session: Pick<CoreSession, "events">) {
    this.session = session;
  }

  get isRunning(): boolean {
    return this.abortController !== undefined;
  }

  async run(): Promise<ConversationTurnResult> {
    if (this.abortController) {
      throw new Error("conversation turn is already running");
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      try {
        for await (const _event of this.session.events(abortController.signal)) {
          if (abortController.signal.aborted) {
            break;
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          throw err;
        }
      }

      return {
        aborted: abortController.signal.aborted,
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
