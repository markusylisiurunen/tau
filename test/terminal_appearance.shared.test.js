import { describe, expect, it } from "vitest";
import {
  classifyTerminalAppearance,
  parseOsc11BackgroundRgb,
} from "../dist/tui/terminal_appearance.js";

describe("terminal appearance detection", () => {
  it("parses OSC 11 rgb replies", () => {
    const belReply = "\x1b]11;rgb:1c1c/1c1c/1c1c\x07";
    const stReply = "\x1b]11;rgb:ffff/ffff/ffff\x1b\\";
    const shortReply = "\x1b]11;rgb:fff/800/000\x07";

    expect(parseOsc11BackgroundRgb(belReply)).toEqual({
      r: 0x1c1c / 65535,
      g: 0x1c1c / 65535,
      b: 0x1c1c / 65535,
    });
    expect(parseOsc11BackgroundRgb(stReply)).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseOsc11BackgroundRgb(shortReply)).toEqual({
      r: 1,
      g: 0x800 / 0xfff,
      b: 0,
    });
  });

  it("returns undefined for malformed replies", () => {
    expect(parseOsc11BackgroundRgb("\x1b]11;?\x07")).toBeUndefined();
    expect(parseOsc11BackgroundRgb("rgb:zz/zz/zz")).toBeUndefined();
  });

  it("classifies luminance as dark or light", () => {
    expect(classifyTerminalAppearance({ r: 0, g: 0, b: 0 })).toBe("dark");
    expect(classifyTerminalAppearance({ r: 1, g: 1, b: 1 })).toBe("light");
    expect(classifyTerminalAppearance({ r: 0.1, g: 0.1, b: 0.1 })).toBe("dark");
  });
});
