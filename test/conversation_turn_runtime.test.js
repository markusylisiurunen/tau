import { describe, expect, it } from "vitest";
import { ConversationTurnRuntime } from "../dist/core/runtime/conversation_turn_runtime.js";

describe("ConversationTurnRuntime", () => {
  it("streams events in order and reports non-aborted completion", async () => {
    const emitted = [
      { type: "notice", severity: "info", text: "first" },
      { type: "notice", severity: "warn", text: "second" },
      { type: "notice", severity: "error", text: "third" },
    ];

    const produced = [];
    const session = {
      async *events(signal) {
        for (const event of emitted) {
          if (signal.aborted) {
            break;
          }
          produced.push(event.text);
          yield event;
        }
      },
    };

    const runtime = new ConversationTurnRuntime(session);

    expect(runtime.isRunning).toBe(false);
    const result = await runtime.run();

    expect(result).toEqual(expect.objectContaining({ aborted: false }));
    expect(produced).toEqual(["first", "second", "third"]);
    expect(runtime.isRunning).toBe(false);
  });

  it("waits for event handlers before consuming the next streamed event", async () => {
    const order = [];
    let releaseFirstHandler;
    let firstHandlerStarted;
    const firstHandlerBlocked = new Promise((resolve) => {
      releaseFirstHandler = resolve;
    });
    const firstHandlerSeen = new Promise((resolve) => {
      firstHandlerStarted = resolve;
    });

    const session = {
      async *events() {
        order.push("yield first");
        yield { type: "notice", severity: "info", text: "first" };
        order.push("after first handler");
        yield { type: "notice", severity: "info", text: "second" };
        order.push("after second handler");
      },
    };

    const runtime = new ConversationTurnRuntime(session);
    const run = runtime.run({
      async onEvent(event) {
        order.push(`handle ${event.text} start`);
        if (event.text === "first") {
          firstHandlerStarted();
          await firstHandlerBlocked;
        }
        order.push(`handle ${event.text} end`);
      },
    });

    await firstHandlerSeen;
    expect(order).toEqual(["yield first", "handle first start"]);

    releaseFirstHandler();
    await expect(run).resolves.toEqual(expect.objectContaining({ aborted: false }));
    expect(order).toEqual([
      "yield first",
      "handle first start",
      "handle first end",
      "after first handler",
      "handle second start",
      "handle second end",
      "after second handler",
    ]);
  });

  it("prevents concurrent runs", async () => {
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });

    const session = {
      async *events() {
        await blocked;
        yield { type: "notice", severity: "info", text: "released" };
      },
    };

    const runtime = new ConversationTurnRuntime(session);
    const firstRun = runtime.run();

    expect(runtime.isRunning).toBe(true);
    await expect(runtime.run()).rejects.toThrow("conversation turn is already running");

    release();
    await firstRun;
    expect(runtime.isRunning).toBe(false);
  });

  it("preserves blocked generator return values", async () => {
    const session = {
      async *events() {
        yield { type: "notice", severity: "info", text: "before block" };
        return {
          aborted: false,
          blocked: {
            reason: "auto-compaction-failed",
            message: "summary failed",
          },
        };
      },
    };

    const runtime = new ConversationTurnRuntime(session);

    await expect(runtime.run()).resolves.toEqual({
      aborted: false,
      blocked: {
        reason: "auto-compaction-failed",
        message: "summary failed",
      },
    });
  });

  it("closes the event stream and preserves handler failures", async () => {
    let returned = false;
    let abortedAtReturn = false;
    const session = {
      events(signal) {
        let emitted = false;
        return {
          async next() {
            if (emitted) {
              return { done: true, value: { aborted: signal.aborted } };
            }
            emitted = true;
            return {
              done: false,
              value: { type: "notice", severity: "info", text: "before failure" },
            };
          },
          async return() {
            returned = true;
            abortedAtReturn = signal.aborted;
            return { done: true, value: { aborted: true } };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    const runtime = new ConversationTurnRuntime(session);

    await expect(
      runtime.run({
        onEvent() {
          throw new Error("snapshot write failed");
        },
      }),
    ).rejects.toThrow("snapshot write failed");
    expect(returned).toBe(true);
    expect(abortedAtReturn).toBe(true);
    expect(runtime.isRunning).toBe(false);
  });

  it("interrupts the active run and reports aborted status", async () => {
    let runtime;
    let seen = 0;
    const session = {
      async *events(signal) {
        yield { type: "notice", severity: "info", text: "tick" };
        seen += 1;
        runtime.interrupt();
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    };

    runtime = new ConversationTurnRuntime(session);

    const result = await runtime.run();

    expect(seen).toBe(1);
    expect(result).toEqual(expect.objectContaining({ aborted: true }));
    expect(runtime.isRunning).toBe(false);
  });
});
