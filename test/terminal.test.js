import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TauTerminal } from "../dist/tui/terminal.js";

function createTerminal(isTTY) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = isTTY;
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  return { terminal: new TauTerminal(input, output), text: () => text };
}

afterEach(() => vi.unstubAllEnvs());

describe("TauTerminal program status", () => {
  it("encodes root status and clears it on stop", () => {
    vi.stubEnv("PI_PROGRAM_STATUS", "1");
    const { terminal, text } = createTerminal(true);
    terminal.setProgramStatus({ state: "working", app: "tau" });
    expect(text()).toBe("\x1b]7501;state=working:app=tau\x1b\\");
    terminal.stop();
    expect(text()).toContain("\x1b]7501;state=clear\x1b\\");
  });

  it.each([false, true])(
    "suppresses status for redirected output or an explicit opt-out (%s)",
    (isTTY) => {
      vi.stubEnv("PI_PROGRAM_STATUS", isTTY ? "0" : "1");
      const { terminal, text } = createTerminal(isTTY);
      terminal.setProgramStatus({ state: "working", app: "tau" });
      terminal.stop();
      expect(text()).not.toContain("7501");
    },
  );
});
