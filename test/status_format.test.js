import { describe, expect, it } from "vitest";
import { formatFooterTokenCount } from "../dist/tui/chat_controller/status_format.js";

describe("footer status formatting", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [1_200, "1.2k"],
    [9_949, "9.9k"],
    [9_950, "10k"],
    [18_234, "18k"],
    [245_678, "246k"],
    [999_499, "999k"],
    [999_500, "1M"],
    [1_250_000, "1.3M"],
    [18_234_567, "18M"],
  ])("formats %i tokens as %s", (tokens, expected) => {
    expect(formatFooterTokenCount(tokens)).toBe(expected);
  });
});
