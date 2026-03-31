export type BusyTask = {
  requestInterrupt: () => boolean;
};

export class InterruptLifecycle {
  private activeBusyTask?: BusyTask;

  createAbortBusyTask(): { busyTask: BusyTask; signal: AbortSignal } {
    const abortController = new AbortController();
    return {
      signal: abortController.signal,
      busyTask: {
        requestInterrupt: () => {
          if (abortController.signal.aborted) {
            return false;
          }
          abortController.abort();
          return true;
        },
      },
    };
  }

  beginBusyTask(task: BusyTask): void {
    this.activeBusyTask = task;
  }

  endBusyTask(task: BusyTask): void {
    if (this.activeBusyTask === task) {
      this.activeBusyTask = undefined;
    }
  }

  interruptActiveTask(isStreaming: boolean): boolean {
    if (!isStreaming) return false;
    if (!this.activeBusyTask) return false;
    return this.activeBusyTask.requestInterrupt();
  }
}
