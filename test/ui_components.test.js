import { visibleWidth } from "@mariozechner/pi-tui";
import { expect, test } from "vitest";
import { AppIntroComponent } from "../dist/tui/ui/app_intro.js";
import { AssistantMessageComponent } from "../dist/tui/ui/assistant_message.js";
import { ChatContainerComponent } from "../dist/tui/ui/chat_container.js";
import { CustomEditor } from "../dist/tui/ui/custom_editor.js";
import { FooterComponent } from "../dist/tui/ui/footer.js";
import {
  OneLineSegmentsComponent,
  truncateFromEndByWidth,
} from "../dist/tui/ui/components/one_line_segments.js";
import { QueuedMessagesComponent } from "../dist/tui/ui/queued_messages.js";
import { SessionDividerComponent } from "../dist/tui/ui/session_divider.js";
import { SessionSummaryComponent } from "../dist/tui/ui/session_summary.js";
import { UserMessageComponent } from "../dist/tui/ui/user_message.js";
import stripAnsi from "strip-ansi";
import { createTagTheme, renderLines, renderText } from "./ui_helpers.js";

function stripTags(text) {
  return stripAnsi(text.replace(/<[^>]+>/g, ""));
}

function createToolView(label) {
  return {
    borderColor: (text) => text,
    expanded: { title: label, sections: [] },
    compact: { extraText: label },
  };
}

test("AppIntroComponent renders header and help text", () => {
  const theme = createTagTheme();
  const component = new AppIntroComponent(theme, {
    appName: "tau",
    version: "1.0.0",
    helpText: "help text",
  });
  const text = renderText(component, 80);
  expect(text).toContain("<brandAccent>tau</brandAccent>");
  expect(text).toContain("<textMuted>– terminal chat (v1.0.0)</textMuted>");
  expect(text).toContain("<textMuted>help text</textMuted>");
});

test("SessionDividerComponent renders a muted divider line", () => {
  const theme = createTagTheme();
  const component = new SessionDividerComponent(theme, { label: "new session" });
  const lines = renderLines(component, 20);
  expect(lines[0]).toBe("<textMuted>── new session ─────</textMuted>");
});

test("SessionSummaryComponent renders borders and summary text", () => {
  const theme = createTagTheme();
  const component = new SessionSummaryComponent(theme, { summary: "summary line" });
  const text = renderText(component, 200);
  expect(text).toContain("<brandAccent>context from previous session</brandAccent>");
  expect(text).toContain("<italic><textMuted>summary line</textMuted></italic>");
});

test("UserMessageComponent applies memory mode styling", () => {
  const theme = createTagTheme();
  const component = new UserMessageComponent(theme, {
    text: "remember this",
    isMemoryMode: true,
  });
  const text = renderText(component, 60);
  expect(text).toContain("<userMemorySurface>");
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

  component.update({ type: "assistant", message });
  let text = renderText(component, 80);
  expect(text).not.toContain("hmm");
  expect(text).toContain("hello");

  component.setThinkingVisibility(true);
  text = renderText(component, 80);
  expect(text).toContain("hmm");
});

test("ChatContainerComponent hides empty assistant messages even when thoughts are visible", () => {
  const theme = createTagTheme();
  const container = new ChatContainerComponent(theme, true);
  container.setCompactToolUi(true);

  container.addMessage({ type: "tool", view: createToolView("tool a") });
  container.addMessage({ type: "assistant_partial", text: "", thinking: "" });
  container.addMessage({ type: "tool", view: createToolView("tool b") });

  const lines = renderLines(container, 80);
  const firstIndex = lines.indexOf("tool a");
  const secondIndex = lines.indexOf("tool b");
  const gap = lines.slice(firstIndex + 1, secondIndex);
  const emptyLines = gap.filter((line) => line.trim() === "");
  expect(emptyLines.length).toBe(1);
});

test("QueuedMessagesComponent renders numbered, italicized previews", () => {
  const theme = createTagTheme();
  const component = new QueuedMessagesComponent(theme, ["first line\nsecond", "third"]);
  const lines = renderLines(component, 80);
  expect(lines[0]).toBe("<textDim> queued (2) — alt+up to edit next</textDim>");
  expect(lines[1]).toBe("<textDim>  1› </textDim><italic><textMuted>first line</textMuted></italic>");
  expect(lines[2]).toBe("<textDim>  2› </textDim><italic><textMuted>third</textMuted></italic>");
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
  expect(line).toContain("<riskReadOnlyText>read-only</riskReadOnlyText>");
  expect(line).toContain("<textDim>ctx 10/100 · $0.01</textDim>");
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
  expect(compactLine).toContain("<textDim>ctx · $0.01</textDim>");

  footer.setStatus({
    contextUsage: "this is a very long context usage string",
    sessionCost: "$0.01",
    riskLevel: "read-only",
  });

  const truncatedLine = renderLines(footer, 40)[0];
  expect(truncatedLine).toContain("<textDim>");
  expect(truncatedLine).toContain("…</textDim>");
  expect(truncatedLine).not.toContain("</textDim>…");
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

test("CustomEditor clamps wrapped lines to the inner width", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setText("1234567890ABCDEFGHIJ");

  const width = 12;
  const lines = editor.render(width).map(stripTags);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("CustomEditor preserves leading indentation for wrapped lines", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setText(
    "- this is the first line\n  - this is the second line with a larger width than the text input has",
  );

  const width = 50;
  const lines = editor.render(width).map(stripTags);
  const contentLines = lines.slice(1, -1).map((line) => line.replace(/\s+$/g, ""));
  const secondLine = contentLines.find((line) => line.includes("second line"));
  expect(secondLine).toBeDefined();
  expect(secondLine).toContain("│  - this is the second line");
});

test("CustomEditor caps height and scrolls within the viewport", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setMaxVisibleLines(6);

  const linesInput = Array.from({ length: 12 }, (_, i) => {
    const label = String(i + 1).padStart(2, "0");
    return `line-${label}`;
  }).join("\n");

  editor.setText(linesInput);

  const lines = editor.render(40).map(stripTags);
  expect(lines).toHaveLength(6);

  const content = lines.slice(1, -1).join("\n");
  expect(content).toContain("line-12");
  expect(content).not.toContain("line-01");
});

test("CustomEditor strips ANSI sequences from input", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.handleInput("hello \u001b[31mred\u001b[0m");
  expect(editor.getLines()[0]).toBe("hello red");
});
