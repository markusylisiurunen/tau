import { describe, expect, it } from "vitest";
import { InterruptLifecycle } from "../dist/tui/chat_controller/interrupt_lifecycle.js";

describe("InterruptLifecycle", () => {
  it("creates abort tasks that only interrupt once", () => {
    const lifecycle = new InterruptLifecycle();
    const { busyTask, signal } = lifecycle.createAbortBusyTask();

    expect(signal.aborted).toBe(false);
    expect(busyTask.requestInterrupt()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(busyTask.requestInterrupt()).toBe(false);
  });

  it("interrupts only with an active busy task", () => {
    const lifecycle = new InterruptLifecycle();
    let interrupts = 0;
    const task = {
      requestInterrupt: () => {
        interrupts += 1;
        return interrupts === 1;
      },
    };

    expect(lifecycle.interruptActiveTask()).toBe(false);

    lifecycle.beginBusyTask(task);
    expect(lifecycle.interruptActiveTask()).toBe(true);
    expect(lifecycle.interruptActiveTask()).toBe(false);

    lifecycle.endBusyTask(task);
    expect(lifecycle.interruptActiveTask()).toBe(false);
    expect(interrupts).toBe(2);
  });
});
