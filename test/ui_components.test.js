import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { expect, test, vi } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import { buildToolRunPresentation } from "../dist/core/tools/presentation.js";
import { TuiChatView } from "../dist/tui/chat_view.js";
import { AssistantMessageComponent } from "../dist/tui/ui/assistant_message.js";
import { ChatContainerComponent } from "../dist/tui/ui/chat_container.js";
import { renderChatMessage } from "../dist/tui/ui/chat_message_model.js";
import { AutocompleteList } from "../dist/tui/ui/components/autocomplete_list.js";
import {
  truncateFromEndByWidth,
  truncateFromEndByWidthPreserveAnsi,
} from "../dist/tui/ui/components/one_line_segments.js";
import { CustomEditor } from "../dist/tui/ui/custom_editor.js";
import { FooterComponent } from "../dist/tui/ui/footer.js";
import { PendingMessagesComponent } from "../dist/tui/ui/pending_messages.js";
import { RewindPickerComponent } from "../dist/tui/ui/rewind_picker.js";
import { SessionDividerComponent } from "../dist/tui/ui/session_divider.js";
import { SlashAutocompleteProvider } from "../dist/tui/ui/slash_autocomplete.js";
import { SubagentPanelComponent } from "../dist/tui/ui/subagent_panel.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";
import { UserMessageComponent } from "../dist/tui/ui/user_message.js";
import { createTagTheme, renderLines, renderText } from "./ui_helpers.js";

function stripTags(text) {
  return stripAnsi(text.replace(/<[^>]+>/g, ""));
}

function createSubagentState(id, title) {
  return {
    id,
    name: "default",
    title,
    availability: "running",
    model: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
    workingDirectory: "/repo",
    createdAt: 1,
    run: {
      revision: 1,
      status: "running",
      startedAt: 1,
      interruptRequested: false,
    },
    costTotal: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: 100,
    },
  };
}

function createToolModel(label) {
  const toolCallId = `tool-${label}`;
  const presentation = buildToolRunPresentation({
    toolName: "bash",
    subject: label,
    details: [{ text: "blocked" }],
  });
  return {
    toolCallId,
    toolName: "bash",
    status: "blocked",
    presentation,
  };
}

function createSlashProvider(options = {}) {
  return new SlashAutocompleteProvider(
    createCommandRegistry(),
    () => options.personas ?? [],
    () => options.prompts ?? [],
    () => options.themes ?? [],
    () => options.files ?? [],
    () => options.skills ?? [],
    () => options.agents ?? [],
  );
}

function applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
  const line = lines[cursorLine] ?? "";
  const beforePrefix = line.slice(0, cursorCol - prefix.length);
  const afterCursor = line.slice(cursorCol);
  const nextLine = beforePrefix + item.value + afterCursor;
  const nextLines = [...lines];
  nextLines[cursorLine] = nextLine;
  return {
    lines: nextLines,
    cursorLine,
    cursorCol: beforePrefix.length + item.value.length,
  };
}

async function waitForAutocomplete(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("TuiChatView switches repeatedly through its retained theme catalog", () => {
  const previousLevel = chalk.level;
  chalk.level = 3;
  try {
    const view = Object.create(TuiChatView.prototype);
    view.terminalAppearance = "dark";
    view.themes = [
      {
        id: "first",
        tokens: { brandAccent: "#ff0000" },
        sourcePath: "first",
        scope: "project",
      },
      {
        id: "second",
        tokens: { brandAccent: "#00ff00" },
        sourcePath: "second",
        scope: "project",
      },
    ];
    view.chatContainer = { setTheme() {} };
    view.footer = { setTheme() {} };
    view.pendingMessages = { setTheme() {} };
    view.subagentPanel = { setTheme() {} };
    view.editor = { setUiTheme() {} };
    view.editorPane = { setTheme() {} };
    view.ui = { invalidate() {}, requestRender() {} };

    view.updateTheme("first");
    const first = view.uiTheme.palette.brandAccent("selected");
    view.updateTheme("second");
    const second = view.uiTheme.palette.brandAccent("selected");

    expect(first).not.toBe(second);
  } finally {
    chalk.level = previousLevel;
  }
});

test("TuiChatView tool reconciliation does not reset subagent state", () => {
  const reconcileSession = vi.fn();
  const resetSubagents = vi.fn();
  const view = Object.create(TuiChatView.prototype);
  view.toolUiRouter = { reconcileSession };
  view.subagentPanel = { reset: resetSubagents };

  view.reconcileToolUiSession([createToolModel("command")]);

  expect(reconcileSession).toHaveBeenCalledOnce();
  expect(resetSubagents).not.toHaveBeenCalled();
});

test("SubagentPanelComponent reconciles snapshots without discarding surviving state", () => {
  const panel = new SubagentPanelComponent(createTagTheme());
  const first = createSubagentState("agent-1", "first task");
  const second = createSubagentState("agent-2", "second task");
  panel.reconcile([
    { state: first, activity: "agent: first snapshot" },
    { state: second, activity: "agent: second snapshot" },
  ]);
  expect(panel.cycleSelection(1)).toBe("agent-2");
  panel.handleEvent({
    type: "subagent_activity",
    state: { ...second, costTotal: 0.01 },
    text: "agent: live progress",
  });

  panel.reconcile([
    { state: first, activity: "agent: first snapshot" },
    {
      state: { ...second, costTotal: 0.01 },
      activity: "agent: canonical progress",
    },
  ]);

  expect(panel.getSelectedId()).toBe("agent-2");
  expect(renderText(panel, 80)).toContain("live progress");
  expect(renderText(panel, 80)).toContain("canonical progress");

  panel.reconcile([{ state: first, activity: "agent: first snapshot" }]);
  expect(panel.getSelectedId()).toBe("agent-1");
  expect(renderText(panel, 80)).not.toContain("second task");
});

test("SessionDividerComponent renders a muted divider line", () => {
  const theme = createTagTheme();
  const component = new SessionDividerComponent(theme, { label: "new session" });
  const lines = renderLines(component, 20);
  expect(lines[0]).toBe("<textMuted>── new session ─────</textMuted>");
});

test("UserMessageComponent renders aligned plain text", () => {
  const component = new UserMessageComponent(createUiTheme("plain"), {
    text: "hey, how\nare you?",
  });

  expect(renderLines(component, 40)).toEqual([" hey, how", " are you?"]);

  component.update({ text: "hey, how are you?" });
  expect(renderLines(component, 12)).toEqual([" hey, how", " are you?"]);

  component.update({ text: "**still plain**" });
  expect(renderText(component, 40).trim()).toBe("**still plain**");
});

test("UserMessageComponent applies review styling", () => {
  const theme = createTagTheme();
  const component = new UserMessageComponent(theme, {
    text: "reviewed the staged changes",
    kind: "review",
  });
  const lines = renderLines(component, 60);
  const text = lines.join("\n");
  expect(lines.every((line) => stripTags(line).trim().length > 0)).toBe(true);
  expect(text).toContain("<userReviewSurface>");
  expect(text).toContain("<userReviewText>");
  expect(text).toContain("<bold>");
  expect(stripTags(text).trimStart()).toMatch(/^reviewed/);
});

test("renderChatMessage renders diff review status with review styling", () => {
  const theme = createTagTheme();
  const rendered = renderChatMessage(
    {
      type: "diff_review",
      status: "active",
      command: "git diff --staged",
      uiText: "http://127.0.0.1:4321",
      reviewAgents: [
        {
          threadId: "12345678-90ab-cdef-1234-567890abcdef",
          status: "running",
          costTotal: 0.12,
          usage: {
            input: 1200,
            output: 320,
            cacheRead: 64,
            cacheWrite: 0,
            contextWindowUsageTokens: 1584,
            contextWindow: 200000,
          },
          lastActivityText: "bash running: git diff --staged",
        },
        {
          threadId: "fedcba98-7654-3210-fedc-ba9876543210",
          status: "idle",
          costTotal: 0.09,
          usage: {
            input: 950,
            output: 210,
            cacheRead: 24,
            cacheWrite: 0,
            contextWindowUsageTokens: 1184,
            contextWindow: 200000,
          },
          lastActivityText: "bash: permission denied",
        },
        {
          threadId: "abcdef12-3456-7890-abcd-ef1234567890",
          status: "idle",
          costTotal: 0.08,
          usage: {
            input: 900,
            output: 220,
            cacheRead: 40,
            cacheWrite: 0,
            contextWindowUsageTokens: 1160,
            contextWindow: 200000,
          },
          lastActivityText: "agent: reviewer brief ready",
        },
      ],
    },
    {
      theme,
      thoughtsVisible: false,
    },
  );

  const text = renderText(rendered.component, 140);
  const plainText = stripTags(text).replace(/\s+/g, " ");
  expect(text).toContain("<userReviewSurface>");
  expect(text).toContain("<userReviewTextMuted>");
  expect(text).toContain("<userReviewTextDim>");
  expect(plainText).toContain("diff tool active (git diff --staged)");
  expect(plainText).toContain("http://127.0.0.1:4321");
  expect(plainText).toContain("12345678-90ab-cdef-1234-567890abcdef (running)");
  expect(plainText).toContain("fedcba98-7654-3210-fedc-ba9876543210 (idle)");
  expect(plainText).toContain("abcdef12-3456-7890-abcd-ef1234567890 (idle)");
  expect(plainText).toContain("↑1.2k ↓320 (r64 w0)");
  expect(plainText).toContain("$0.12");
  expect(plainText).toContain("$ git diff --staged");
  expect(plainText).toContain("$ (error): permission denied");
  expect(plainText).toContain("> reviewer brief ready");
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

test("AssistantMessageComponent toggles partial thinking visibility", () => {
  const theme = createTagTheme();
  const component = new AssistantMessageComponent(theme, undefined, false);

  component.update({ type: "assistant_partial", text: "hello", thinking: "hmm" });
  let text = renderText(component, 80);
  expect(text).not.toContain("hmm");
  expect(text).toContain("hello");

  component.setThinkingVisibility(true);
  text = renderText(component, 80);
  expect(text).toContain("hmm");
  expect(text).toContain("hello");
});

test("ChatContainerComponent hides empty assistant messages even when thoughts are visible", () => {
  const theme = createTagTheme();
  const container = new ChatContainerComponent(theme, true);

  container.addMessage({ type: "tool", tool: createToolModel("tool a") });
  container.addMessage({ type: "assistant_partial", text: "", thinking: "" });
  container.addMessage({ type: "tool", tool: createToolModel("tool b") });

  const lines = renderLines(container, 80);
  const firstIndex = lines.indexOf("tool a");
  const secondIndex = lines.indexOf("tool b");
  const gap = lines.slice(firstIndex + 1, secondIndex);
  const emptyLines = gap.filter((line) => line.trim() === "");
  expect(emptyLines.length).toBe(1);
});

test("PendingMessagesComponent distinguishes steering and queued previews", () => {
  const theme = createTagTheme();
  const component = new PendingMessagesComponent(theme);
  component.setMessages([
    { id: "steer-1", mode: "steer", text: "change direction\nsecond" },
    { id: "queue-1", mode: "queue", text: "first queued" },
    { id: "queue-2", mode: "queue", text: "second queued" },
  ]);
  const lines = renderLines(component, 80);
  expect(lines[0]).toBe("<textDim> pending (3) · alt+up edit all</textDim>");
  expect(lines[1]).toBe(
    "<textDim>  ↳ </textDim><italic><textMuted>change direction</textMuted></italic>",
  );
  expect(lines[2]).toBe(
    "<textDim>  1› </textDim><italic><textMuted>first queued</textMuted></italic>",
  );
  expect(lines[3]).toBe(
    "<textDim>  2› </textDim><italic><textMuted>second queued</textMuted></italic>",
  );
});

test("FooterComponent renders session status", () => {
  const theme = createTagTheme();
  const ui = { requestRender() {} };
  const footer = new FooterComponent(theme, ui);
  footer.setStatus({
    contextUsage: "ctx 10/100",
    sessionCost: "$0.01",
    duration: "",
    pursuingGoal: false,
  });
  const line = renderLines(footer, 120)[0];
  expect(line).toContain("<textDim>ctx 10/100 · $0.01</textDim>");
});

test("FooterComponent renders operation status hints", () => {
  const theme = createTagTheme();
  const ui = { requestRender() {} };
  const footer = new FooterComponent(theme, ui);
  footer.setStatus({
    contextUsage: "ctx 10/100",
    sessionCost: "$0.01",
    duration: "",
    statusHint: "compacting context...",
    pursuingGoal: false,
  });

  expect(renderText(footer, 120)).toContain("compacting context...");
});

test("FooterComponent labels active autonomous goal work", () => {
  const theme = createTagTheme();
  const ui = { requestRender() {} };
  const footer = new FooterComponent(theme, ui);
  footer.setStatus({
    contextUsage: "ctx 10/100",
    sessionCost: "$0.01",
    duration: "24s",
    pursuingGoal: true,
  });

  const idleLine = renderLines(footer, 120)[0];
  expect(idleLine).not.toContain("pursuing goal");
  expect(idleLine).toContain("<textDim>24s · ctx 10/100 · $0.01</textDim>");

  footer.startWorkingIcon();
  try {
    const activeLine = renderLines(footer, 120)[0];
    expect(activeLine).toContain(
      "<brandAccent>⠋</brandAccent> <brandAccent>pursuing goal</brandAccent> <textDim>·</textDim>",
    );
  } finally {
    footer.stop();
  }
});

test("FooterComponent compacts cwd before truncating and keeps ellipsis styled", () => {
  const theme = createTagTheme();
  const ui = { requestRender() {} };
  const footer = new FooterComponent(theme, ui);
  footer.setStatus({
    contextUsage: "ctx",
    sessionCost: "$0.01",
    duration: "",
    pursuingGoal: false,
  });

  const compactLine = renderLines(footer, 50)[0];
  expect(compactLine).toContain("<textDim>ctx · $0.01</textDim>");

  footer.setStatus({
    contextUsage: "this is a very long context usage string",
    sessionCost: "$0.01",
    duration: "",
    pursuingGoal: false,
  });

  const truncatedLine = renderLines(footer, 40)[0];
  expect(truncatedLine).toContain("<textDim>");
  expect(truncatedLine).toContain("…</textDim>");
  expect(truncatedLine).not.toContain("</textDim>…");
});

test("truncateFromEndByWidth respects max width", () => {
  expect(truncateFromEndByWidth("hello", 1)).toBe("…");
  expect(truncateFromEndByWidth("hello", 4)).toBe("hel…");
  expect(truncateFromEndByWidth("hello", 5)).toBe("hello");
});

test("truncateFromEndByWidthPreserveAnsi keeps the ellipsis inside the active style", () => {
  const red = `\x1b[31mhello world\x1b[0m`;
  const truncated = truncateFromEndByWidthPreserveAnsi(red, 6);

  expect(stripAnsi(truncated)).toBe("hello…");
  expect(truncated).toContain("hello…\x1b[0m");
  expect(truncated).not.toContain("\x1b[0m…");
});

test("CustomEditor renders one content row when empty", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);

  const lines = editor.render(40).map(stripTags);
  expect(lines).toHaveLength(3);
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

test("CustomEditor strips ANSI sequences from insertTextAtCursor", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);

  editor.insertTextAtCursor("hello \u001b[31mred\u001b[0m");

  expect(editor.getText()).toBe("hello red");
});

test("CustomEditor preserves tabs when restoring text", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);

  editor.setText("\tcolumn1\tcolumn2");

  expect(editor.getText()).toBe("\tcolumn1\tcolumn2");
});

test("CustomEditor renders the cursor over an entire paste marker", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  const pasted = Array.from({ length: 33 }, () => "...is $1.75 / $14 for Codex...").join("\n");

  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  editor.handleInput("\x1b[D");

  const content = editor.render(40).slice(1, -1).join("\n");
  expect(content).toContain("<cursor>[paste #1 +33 lines]</cursor>");
  expect(content).not.toContain("<cursor>[</cursor>paste #1 +33 lines]");
});

test("CustomEditor inserts Kitty CSI-u printable characters", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);

  editor.handleInput("\u001b[97u");

  expect(editor.getText()).toBe("a");
});

test("CustomEditor does not trigger slash autocomplete in multiline drafts", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setAutocompleteProvider(createSlashProvider());
  editor.setText("\nworld");

  editor.handleInput("\x1b[A");
  editor.handleInput("/");

  expect(editor.getText()).toBe("/\nworld");
  expect(editor.isShowingAutocomplete()).toBe(false);
});

test("CustomEditor refreshes slash autocomplete after insertTextAtCursor", async () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  let submitted;
  editor.onSubmit = (text) => {
    submitted = text;
  };
  editor.setAutocompleteProvider(createSlashProvider());

  editor.handleInput("/");
  await waitForAutocomplete();
  expect(editor.isShowingAutocomplete()).toBe(true);
  const autocomplete = editor.render(80).join("\n");
  expect(autocomplete).not.toContain("→");
  expect(autocomplete).toContain("<autocompleteSelectedSurface>");
  expect(autocomplete).toContain("<autocompleteSelectedText>");

  editor.insertTextAtCursor("zzzz");
  await waitForAutocomplete();

  expect(editor.getText()).toBe("/zzzz");
  expect(editor.isShowingAutocomplete()).toBe(false);

  editor.handleInput("\r");

  expect(submitted).toBe("/zzzz");
});

test("AutocompleteList keeps truncated selection padding inside its full-width background", () => {
  const theme = createTagTheme();
  const list = new AutocompleteList(
    [
      {
        value: "persona:gpt-5.6-sol-chatgpt-coder",
        label: "persona:gpt-5.6-sol-chatgpt-coder",
        description: "switch to gpt-5.6-sol-chatgpt-coder",
      },
    ],
    5,
    theme.editorTheme.selectList,
    {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 32,
      truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
    },
  );

  const line = list.render(50)[0];
  const plain = stripTags(line);
  expect(line).toMatch(/^<autocompleteSelectedSurface>/);
  expect(line).toMatch(/<\/autocompleteSelectedSurface>$/);
  expect(line).not.toContain("\x1b");
  expect(plain).toMatch(/^ \S/);
  expect(plain).toMatch(/\s$/);
  expect(plain).toContain("…");
  expect(visibleWidth(plain)).toBe(50);
});

test("CustomEditor renders autocomplete items with one-column side padding", async () => {
  const editor = new CustomEditor(createUiTheme("plain"));
  editor.setAutocompleteProvider(createSlashProvider());

  editor.handleInput("/");
  await waitForAutocomplete();

  const rendered = editor.render(50);
  const suggestions = rendered.slice(3, 11);
  expect(suggestions).toHaveLength(8);
  for (const line of suggestions) {
    expect(line).toMatch(/^ \S/);
    expect(line).toMatch(/\s$/);
    expect(visibleWidth(line)).toBe(50);
  }
  expect(rendered[11]).toMatch(/^ \(/);
});

test("SlashAutocompleteProvider exposes sorted command submenus", async () => {
  const provider = createSlashProvider({
    personas: [{ id: "zeta" }, { id: "alpha" }],
    prompts: [{ id: "review" }],
    themes: [{ id: "gold" }, { id: "cyan" }],
  });
  const options = { signal: new AbortController().signal };

  const topLevel = await provider.getSuggestions(["/"], 0, 1, options);
  const topLevelLabels = topLevel.items.map((item) => item.label);
  expect(topLevelLabels).toEqual(
    [...topLevelLabels].sort((left, right) => left.localeCompare(right)),
  );
  expect(topLevel.items.filter((item) => item.label === "persona")).toEqual([
    expect.objectContaining({ value: "persona:", autocompleteAction: "navigate" }),
  ]);
  expect(topLevelLabels.every((label) => !label.includes(":"))).toBe(true);
  expect(topLevelLabels).toEqual(
    expect.arrayContaining(["compact-all", "compact-keep-last", "copy-code", "copy-text"]),
  );
  expect(topLevel.items.every((item) => item.description)).toBe(true);
  expect(topLevel.items.find((item) => item.label === "help")?.description).toBe(
    "show commands and keyboard shortcuts",
  );
  expect(topLevel.items.find((item) => item.label === "persona")?.description).toBe(
    "change model, instructions, and tools",
  );

  const filtered = await provider.getSuggestions(["/pera"], 0, 5, options);
  expect(filtered.items[0]?.label).toBe("persona");
  expect(await provider.getSuggestions(["/keyboard"], 0, 9, options)).toBeNull();

  const personas = await provider.getSuggestions(["/persona:"], 0, 9, options);
  expect(personas.items.map((item) => item.label)).toEqual(["alpha", "zeta"]);
  expect(personas.items.every((item) => item.autocompleteAction === "submit")).toBe(true);

  const modelProvider = createSlashProvider({
    personas: [
      {
        id: "gpt-5.6-luna-chatgpt-fast-coder",
        label: "GPT-5.6 Luna ChatGPT Fast Coder",
      },
      { id: "gpt-5.6-sol-chatgpt-coder", label: "GPT-5.6 Sol ChatGPT Coder" },
      {
        id: "gpt-5.6-sol-chatgpt-fast-coder",
        label: "GPT-5.6 Sol ChatGPT Fast Coder",
      },
    ],
  });
  const query = "/persona:5.6solchatgptcoder";
  const matchingPersonas = await modelProvider.getSuggestions([query], 0, query.length, options);
  expect(matchingPersonas.items.map((item) => item.label)).toEqual([
    "gpt-5.6-sol-chatgpt-coder",
    "gpt-5.6-sol-chatgpt-fast-coder",
  ]);

  const aliasProvider = createSlashProvider({
    personas: [{ id: "alpha", label: "GPT Fast" }],
  });
  expect(
    await aliasProvider.getSuggestions(["/persona:gptfast"], 0, "/persona:gptfast".length, options),
  ).toBeNull();
});

test("CustomEditor navigates submenus and submits repeated theme selections", async () => {
  const editor = new CustomEditor(createTagTheme());
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setAutocompleteProvider(createSlashProvider({ themes: [{ id: "gold" }, { id: "cyan" }] }));

  for (const char of "/the") editor.handleInput(char);
  await waitForAutocomplete(25);
  editor.handleInput("\r");
  await waitForAutocomplete();
  expect(editor.getText()).toBe("/theme:");
  expect(editor.isShowingAutocomplete()).toBe(true);
  editor.handleInput("\x1b[B");
  editor.handleInput("\r");
  expect(submitted).toEqual(["/theme:gold"]);

  editor.setUiTheme(createTagTheme());
  for (const char of "/the") editor.handleInput(char);
  await waitForAutocomplete(25);
  editor.handleInput("\r");
  await waitForAutocomplete();
  editor.handleInput("\r");
  expect(submitted).toEqual(["/theme:gold", "/theme:cyan"]);
});

test("CustomEditor refreshes autocomplete after word and line deletion", async () => {
  const editor = new CustomEditor(createUiTheme("plain"));
  editor.setAutocompleteProvider(
    createSlashProvider({ personas: [{ id: "luna" }, { id: "sol" }] }),
  );

  for (const char of "/persona:luna") editor.handleInput(char);
  await waitForAutocomplete();
  expect(editor.isShowingAutocomplete()).toBe(true);
  expect(editor.render(60).join("\n")).not.toContain(" sol");

  editor.handleInput("\x17");
  await waitForAutocomplete();
  expect(editor.getText()).toBe("/persona:");
  expect(editor.render(60).join("\n")).toContain(" sol");

  editor.handleInput("\x15");
  await waitForAutocomplete();
  expect(editor.getText()).toBe("");
  expect(editor.isShowingAutocomplete()).toBe(false);
});

test("CustomEditor keeps the exact file mention match from the real provider", async () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setAutocompleteProvider(createSlashProvider({ files: ["foo.tsx", "foo.ts"] }));

  for (const char of "@foo.ts") {
    editor.handleInput(char);
  }
  await waitForAutocomplete(25);

  const autocomplete = editor.render(40).map(stripTags).join("\n");
  expect(autocomplete).toContain("foo.tsx");
  expect(autocomplete).toContain("foo.ts");

  editor.handleInput("\r");

  expect(editor.getText()).toBe("@foo.ts ");
  expect(editor.isShowingAutocomplete()).toBe(false);
});

test("CustomEditor applies a single forced file completion on Tab", async () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setAutocompleteProvider({
    getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
      const text = lines[0] ?? "";
      const beforeCursor = text.slice(0, cursorCol);
      if (!options.force || beforeCursor !== "Work") return null;
      return {
        prefix: "Work",
        items: [{ value: "Workspace/", label: "Workspace/" }],
      };
    },
    applyCompletion,
  });
  editor.setText("Work");

  editor.handleInput("\t");
  await waitForAutocomplete();

  expect(editor.getText()).toBe("Workspace/");
  expect(editor.isShowingAutocomplete()).toBe(false);
});

test("CustomEditor treats large paste markers atomically on wrapped vertical navigation", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  const pasted = Array.from({ length: 33 }, () => "...is $1.75 / $14 for Codex...").join("\n");

  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  editor.render(10);
  editor.handleInput("\x1b[A");
  editor.handleInput("\x7f");

  expect(editor.getText()).toBe("");
});

test("CustomEditor insertTextAtCursor exits history browsing mode", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.addToHistory("older");
  editor.addToHistory("recent");

  editor.handleInput("\x1b[A");
  expect(editor.getText()).toBe("recent");

  editor.insertTextAtCursor("!");
  editor.handleInput("\x1b[B");

  expect(editor.getText()).toBe("recent!");
});

test("CustomEditor expands large paste markers without token interpolation", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  const pasted = Array.from({ length: 33 }, () => "...is $1.75 / $14 for Codex...").join("\n");

  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);

  expect(editor.getText()).toBe("[paste #1 +33 lines]");
  expect(editor.getExpandedText()).toBe(pasted);
});

test("CustomEditor submit preserves replacement-like tokens in large pastes", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  const pasted = Array.from({ length: 33 }, () => "...is $1.75 / $14 for Codex...").join("\n");
  let submitted;
  editor.onSubmit = (text) => {
    submitted = text;
  };

  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  editor.handleInput("\r");

  expect(submitted).toBe(pasted);
});

test("CustomEditor renders cursor with theme tags", () => {
  const theme = createTagTheme();
  const editor = new CustomEditor(theme);
  editor.setText("abc");

  const lines = editor.render(20);
  const content = lines.slice(1, -1).join("");
  expect(content).toContain("<cursor>");
  expect(content).not.toContain("\x1b[7m");
});

test("RewindPickerComponent shows at most eight options", () => {
  const theme = createTagTheme();
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    label: `message-${String(index + 1).padStart(2, "0")}`,
    description: "now",
  }));
  const picker = new RewindPickerComponent(theme, items);

  const rendered = renderLines(picker, 60);
  const lines = rendered.map(stripTags);
  const optionLines = lines.filter((line) => line.includes("message-"));

  expect(optionLines).toHaveLength(8);
  expect(lines[0]).toBe(" rewind · enter select · esc cancel");
  expect(lines.join("\n")).not.toMatch(/[┌┐└┘│]/);
  expect(rendered.join("\n")).toContain("<autocompleteSelectedSurface>");
  expect(rendered.join("\n")).toContain("<textMuted>now</textMuted>");
  expect(lines.join("\n")).toContain(" now     message-12");
  expect(lines.join("\n")).toContain("message-12");
  expect(lines.join("\n")).not.toContain("message-01");
});

test("RewindPickerComponent gives the message the remaining terminal width", () => {
  const message = "x".repeat(64);
  const picker = new RewindPickerComponent(createUiTheme("plain"), [
    { id: "0", label: message, description: "2m ago" },
  ]);

  expect(renderText(picker, 80)).toContain(message);
  expect(renderText(picker, 30)).toContain("2m ago  x");
});

test("RewindPickerComponent confirms and cancels selection", () => {
  const theme = createTagTheme();
  const items = [
    { id: "0", label: "first", description: "2m ago" },
    { id: "1", label: "second", description: "now" },
  ];
  const picker = new RewindPickerComponent(theme, items);

  let selected;
  let cancelled = false;
  picker.onSelect = (id) => {
    selected = id;
  };
  picker.onCancel = () => {
    cancelled = true;
  };

  picker.handleInput("\r");
  picker.handleInput("\u001b");

  expect(selected).toBe("1");
  expect(cancelled).toBe(true);
});
