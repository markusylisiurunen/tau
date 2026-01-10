import { expect, test } from "vitest";
import { AppIntroComponent } from "../dist/ui/app_intro.js";
import { AssistantMessageComponent } from "../dist/ui/assistant_message.js";
import { FooterComponent } from "../dist/ui/footer.js";
import { OneLineSegmentsComponent, truncateFromEndByWidth } from "../dist/ui/components/one_line_segments.js";
import { QueuedMessagesComponent } from "../dist/ui/queued_messages.js";
import { SessionDividerComponent } from "../dist/ui/session_divider.js";
import { SessionSummaryComponent } from "../dist/ui/session_summary.js";
import { UserMessageComponent } from "../dist/ui/user_message.js";
import { createTagTheme, renderLines, renderText } from "./ui_helpers.js";

test("AppIntroComponent renders header and help text", () => {
  const theme = createTagTheme();
  const component = new AppIntroComponent(theme, "tau", "1.0.0", "help text");
  const text = renderText(component, 80);
  expect(text).toContain("<accent>tau</accent>");
  expect(text).toContain("<muted>– terminal chat (v1.0.0)</muted>");
  expect(text).toContain("<muted>help text</muted>");
});

test("SessionDividerComponent renders a muted divider line", () => {
  const theme = createTagTheme();
  const component = new SessionDividerComponent(theme, "new session");
  const lines = renderLines(component, 20);
  expect(lines[0]).toBe("<muted>─── new session ────</muted>");
});

test("SessionSummaryComponent renders borders and summary text", () => {
  const theme = createTagTheme();
  const component = new SessionSummaryComponent(theme, "summary line");
  const text = renderText(component, 200);
  expect(text).toContain("<accent><bold>◆ context from previous session</bold></accent>");
  expect(text).toContain("<italic><muted>summary line</muted></italic>");
});

test("UserMessageComponent applies memory mode styling", () => {
  const theme = createTagTheme();
  const component = new UserMessageComponent(theme, "remember this", { isMemoryMode: true });
  const text = renderText(component, 60);
  expect(text).toContain("<userMemoryBg>");
  expect(text).toContain("<userMemoryText>remember this</userMemoryText>");
});

test("AssistantMessageComponent toggles thinking visibility", () => {
  const theme = createTagTheme();
  const component = new AssistantMessageComponent(theme, undefined, false);
  const message = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hello" },
    ],
  };

  component.updateFromMessage(message);
  let text = renderText(component, 80);
  expect(text).not.toContain("hmm");
  expect(text).toContain("hello");

  component.setThinkingVisibility(true);
  text = renderText(component, 80);
  expect(text).toContain("hmm");
});

test("QueuedMessagesComponent renders numbered, italicized previews", () => {
  const theme = createTagTheme();
  const component = new QueuedMessagesComponent(theme, ["first line\nsecond", "third"]);
  const lines = renderLines(component, 80);
  expect(lines[0]).toBe("<dim> queued (2) — alt+up to edit next</dim>");
  expect(lines[1]).toBe("<dim>  1› </dim><italic><muted>first line</muted></italic>");
  expect(lines[2]).toBe("<dim>  2› </dim><italic><muted>third</muted></italic>");
});

test("FooterComponent renders risk label with styling", () => {
  const theme = createTagTheme();
  const ui = { requestRender() {} };
  const footer = new FooterComponent(theme, ui);
  footer.setStatus({
    contextUsage: "ctx 10/100",
    sessionCost: "$0.01",
    riskLevel: "read-only",
  });
  const line = renderLines(footer, 120)[0];
  expect(line).toContain("<riskReadOnly>read-only</riskReadOnly>");
  expect(line).toContain("<dim>ctx 10/100 · $0.01</dim>");
});

test("FooterComponent compacts cwd before truncating and keeps ellipsis styled", () => {
  const theme = createTagTheme();
  const ui = { requestRender() {} };
  const footer = new FooterComponent(theme, ui);
  footer.setStatus({
    contextUsage: "ctx",
    sessionCost: "$0.01",
    riskLevel: "read-only",
  });

  const compactLine = renderLines(footer, 50)[0];
  expect(compactLine).toContain("<dim>ctx · $0.01</dim>");

  footer.setStatus({
    contextUsage: "this is a very long context usage string",
    sessionCost: "$0.01",
    riskLevel: "read-only",
  });

  const truncatedLine = renderLines(footer, 40)[0];
  expect(truncatedLine).toContain("<dim>");
  expect(truncatedLine).toContain("…</dim>");
  expect(truncatedLine).not.toContain("</dim>…");
});

test("OneLineSegmentsComponent truncates flex segments", () => {
  const component = new OneLineSegmentsComponent(
    [
      { text: "hello", style: (s) => s },
      { text: "world", style: (s) => s },
    ],
    [1],
  );
  const line = renderLines(component, 8)[0];
  expect(line).toBe("hellowo…");
});

test("truncateFromEndByWidth respects max width", () => {
  expect(truncateFromEndByWidth("hello", 1)).toBe("…");
  expect(truncateFromEndByWidth("hello", 4)).toBe("hel…");
  expect(truncateFromEndByWidth("hello", 5)).toBe("hello");
});
