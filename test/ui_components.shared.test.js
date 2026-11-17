import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { expect, test, vi } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import { AppIntroComponent } from "../dist/tui/ui/app_intro.js";
import { renderHorizontalRule } from "../dist/tui/ui/components/horizontal_rule.js";
import { CustomEditor } from "../dist/tui/ui/custom_editor.js";
import { PendingMessagesComponent } from "../dist/tui/ui/pending_messages.js";
import { SlashAutocompleteProvider } from "../dist/tui/ui/slash_autocomplete.js";
import { SubagentEditorPaneComponent } from "../dist/tui/ui/subagent_editor_pane.js";
import { SubagentPanelComponent } from "../dist/tui/ui/subagent_panel.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";
import { createTagTheme, renderLines } from "./ui_helpers.js";

test("AppIntroComponent reflows without losing content and caps its width", () => {
  const names = ["alpha-skill", "beta-skill", "gamma-skill", "delta-skill"];
  const path = `/${"directory,entry/".repeat(15)}AGENTS.md`;
  const intro = new AppIntroComponent(createUiTheme("plain"), {
    title: "tau v1 · 4 skills",
    body: ["skills:", { names }, "", "context files:", `  ${path}`],
  });
  const wide = intro.render(160).map(stripAnsi);
  expect(wide).toEqual(intro.render(100).map(stripAnsi));
  for (const width of [1, 2, 3, 20, 40, 80]) {
    const lines = intro.render(width).map(stripAnsi);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    const compact = lines.join("").replaceAll(" ", "");
    for (const value of [...names, path]) expect(compact).toContain(value);
    if (width >= 20) {
      const bodyLines = lines.slice(4).filter((line) => line.trim() && !line.trim().endsWith(":"));
      expect(bodyLines.every((line) => line.startsWith("   "))).toBe(true);
    }
  }
  expect(intro.render(160).map(stripAnsi)).toEqual(wide);
});

test("AppIntroComponent wraps between names without isolated separators", () => {
  const intro = new AppIntroComponent(createUiTheme("plain"), {
    title: "tau",
    body: ["skills:", { names: ["alpha", "abcdefghijklmnop", "zeta", "eta"] }],
  });
  expect(intro.render(20).map(stripAnsi).slice(4)).toEqual([
    "   alpha",
    "   abcdefghijklmnop",
    "   zeta, eta",
  ]);
  expect(intro.render(40).map(stripAnsi).slice(4)).toEqual([
    "   alpha, abcdefghijklmnop, zeta, eta",
  ]);
  expect(intro.render(20).map(stripAnsi).slice(4)).toEqual([
    "   alpha",
    "   abcdefghijklmnop",
    "   zeta, eta",
  ]);
});

function stripTags(text) {
  return stripAnsi(text.replace(/<[^>]+>/g, ""));
}

function createSubagentState(id, title, parentId = "session-1", depth = 1) {
  return {
    id,
    parentId,
    depth,

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

test("SubagentPanelComponent cycles running workers branch by branch", () => {
  const panel = new SubagentPanelComponent(createUiTheme("plain"));
  const parentA = createSubagentState("a", "branch a");
  const parentB = createSubagentState("b", "branch b");
  const childA1 = createSubagentState("a1", "child a1", "a", 2);
  const childB1 = createSubagentState("b1", "child b1", "b", 2);
  const childA2 = createSubagentState("a2", "child a2", "a", 2);
  panel.reconcile(
    [parentA, parentB, childA1, childB1, childA2].map((state) => ({ state, activities: [] })),
  );

  expect(panel.getSelectedId()).toBe("a");
  const order = Array.from({ length: 5 }, () => panel.cycleSelection(1));
  expect(order).toEqual(["a1", "a2", "b", "b1", "a"]);

  // A child launched later joins its branch instead of the end of the cycle.
  const childA3 = createSubagentState("a3", "child a3", "a", 2);
  panel.handleEvent({ type: "subagent_spawned", state: childA3 });
  expect(panel.cycleSelection(1)).toBe("a1");
  panel.cycleSelection(1);
  expect(panel.cycleSelection(1)).toBe("a3");
  expect(panel.cycleSelection(1)).toBe("b");

  // An idle parent stays out of the cycle, but its running children keep their position.
  panel.handleEvent({
    type: "subagent_finished",
    state: {
      ...parentA,
      availability: "idle",
      run: { revision: 1, status: "succeeded", startedAt: 1, finishedAt: 2, response: "done" },
    },
  });
  expect(panel.getSelectedId()).toBe("b");
  expect(panel.cycleSelection(-1)).toBe("a3");
  expect(panel.cycleSelection(1)).toBe("b");
  expect(panel.cycleSelection(1)).toBe("b1");
  expect(panel.cycleSelection(1)).toBe("a1");
});

test("PendingMessagesComponent hides leading instructions in queued and steering previews", () => {
  const component = new PendingMessagesComponent(createUiTheme("plain"));
  component.setMessages([
    {
      id: "steer",
      mode: "steer",
      text: "<system>A</system>\n<system>B</system>\nchange direction",
    },
    { id: "queue", mode: "queue", text: "<system>A</system>\nrun tests\nsecond line" },
    { id: "literal", mode: "queue", text: "show <system>literal</system> text" },
  ]);
  const lines = renderLines(component, 80).map((line) => stripAnsi(line));
  expect(lines.slice(1)).toEqual([
    "  ↳ change direction",
    "  1› run tests",
    "  2› show <system>literal</system> text",
  ]);
});

test("CustomEditor keeps the draft and cursor locked while speech input is active", () => {
  const editor = new CustomEditor(createUiTheme("plain"));
  editor.setText("draft");
  const cursor = editor.getCursor();
  let stops = 0;
  editor.onEscape = () => stops++;
  editor.setInputEnabled(false);
  for (const input of ["x", "\x1b[A", "\x13", "\r", "\x1b", "\x1b"]) editor.handleInput(input);
  expect(stops).toBe(2);
  expect(editor.getText()).toBe("draft");
  expect(editor.getCursor()).toEqual(cursor);
  editor.setInputEnabled(true);
  editor.handleInput("x");
  expect(editor.getText()).toBe("draftx");
});

test("CustomEditor does not carry a pre-recording Escape into draft clearing", () => {
  const editor = new CustomEditor(createUiTheme("plain"));
  editor.setText("draft");
  editor.onEscape = () => {};
  editor.handleInput("\x1b");
  editor.setInputEnabled(false);
  editor.setInputEnabled(true);
  editor.handleInput("\x1b");
  expect(editor.getText()).toBe("draft");
});

test("CustomEditor preview styling preserves wrapped Unicode layout and cursor position", () => {
  const editor = new CustomEditor(createUiTheme("ansi"));
  const plain = new CustomEditor(createUiTheme("plain"));
  for (const target of [editor, plain]) target.setText("prefix ");
  const preview = editor.beginTextPreview();
  const text = "こんにちは é words that wrap\n  more speech";
  preview.update(text);
  plain.insertTextAtCursor(text);
  for (const width of [12, 22, 80]) {
    const rendered = editor.render(width);
    expect(rendered.map(stripAnsi)).toEqual(plain.render(width));
    expect(rendered.join("\n")).toContain("\x1b[3m");
    expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  expect(editor.getCursor()).toEqual(plain.getCursor());
  expect(editor.getText()).toBe(plain.getText());
  preview.commit(text);
  expect(editor.render(80).join("\n")).not.toContain("\x1b[3m");
});

test("horizontal rules preserve label priority and align labels to the available edges", () => {
  const style = (text) => `\x1b[2m${text}\x1b[22m`;
  for (const labels of [
    {},
    { left: "subagents" },
    { right: "right-side" },
    { left: "こんにちは é", right: "right-side" },
  ]) {
    for (let width = 0; width <= 40; width++) {
      const line = renderHorizontalRule(width, { style, ...labels });
      expect(visibleWidth(line)).toBe(width);
      if (width > 0) expect(line).toBe(style(stripAnsi(line)));
      const labelWidth = Object.values(labels).reduce(
        (total, label) => total + visibleWidth(label) + 1,
        0,
      );
      if (width >= labelWidth) {
        if (labels.left) expect(stripAnsi(line).startsWith(labels.left)).toBe(true);
        if (labels.right) expect(stripAnsi(line).endsWith(labels.right)).toBe(true);
      }
    }
  }
  expect(
    stripAnsi(
      renderHorizontalRule(11, {
        style,
        left: "left-side",
        right: "right-side",
      }),
    ),
  ).toBe(" right-side");
});

test("SubagentPanelComponent gives activity rows the full panel width without indentation", () => {
  const panel = new SubagentPanelComponent(createUiTheme("plain"));
  const title = "a".repeat(76);
  panel.reconcile([
    {
      state: createSubagentState("a", "worker"),
      activities: [{ type: "notice", severity: "info", title }],
    },
  ]);
  expect(panel.render(78)[1]).toBe(`· ${title}`);
});

test("SubagentEditorPaneComponent composes complete sections within one shared margin", () => {
  const theme = createUiTheme("ansi");
  const editor = new CustomEditor(theme);
  const panel = new SubagentPanelComponent(theme);
  const pane = new SubagentEditorPaneComponent(theme, panel, editor);
  editor.setText("こんにちは é words that wrap");
  editor.setHeader("left-heading", "right-heading");

  for (const active of [false, true]) {
    panel.reconcile(active ? [{ state: createSubagentState("a", "worker"), activities: [] }] : []);
    for (const width of [0, 1, 2, 3, 4, 5, 8, 12, 22, 80]) {
      const lines = pane.render(width);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      if (width <= 2) {
        expect(lines).toEqual([" ".repeat(width)]);
        continue;
      }
      expect(lines.every((line) => line.startsWith(" ") && line.endsWith(" "))).toBe(true);
      const editorLines = editor.render(width - 2).map((line) => ` ${line} `);
      expect(lines.slice(-editorLines.length)).toEqual(editorLines);
      if (active)
        expect(lines.length).toBe(editorLines.length + panel.render(width - 2).length + 1);
      else expect(lines).toEqual(editorLines);
    }
  }
});

test("SubagentEditorPaneComponent keeps the rendered cursor inset after wrapping and resizing", () => {
  const theme = createUiTheme("plain");
  theme.text.cursor = (text) => `\x1b[7m${text}\x1b[27m`;
  const editor = new CustomEditor(theme);
  const pane = new SubagentEditorPaneComponent(theme, new SubagentPanelComponent(theme), editor);

  for (const text of ["", "abcdefgh", "こんにちは é words that wrap"]) {
    editor.setText(text);
    for (const width of [10, 22, 10]) {
      const lines = pane.render(width);
      const cursorLine = lines.find((line) => line.includes("\x1b[7m"));
      expect(cursorLine).toBeDefined();
      const [before, rest] = cursorLine.split("\x1b[7m");
      const [cursor] = rest.split("\x1b[27m");
      expect(visibleWidth(before)).toBeGreaterThanOrEqual(1);
      expect(visibleWidth(before) + visibleWidth(cursor)).toBeLessThanOrEqual(width - 1);
    }
  }

  editor.setText("abcdefghij");
  pane.render(10);
  editor.handleInput("\x1b[A");
  expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
  pane.render(22);
  editor.handleInput("\x1b[B");
  expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
});

test("SubagentEditorPaneComponent includes autocomplete within the shared margin", async () => {
  const theme = createUiTheme("ansi");
  const editor = new CustomEditor(theme);
  const panel = new SubagentPanelComponent(theme);
  const pane = new SubagentEditorPaneComponent(theme, panel, editor);
  editor.setAutocompleteProvider(createSlashProvider());
  editor.handleInput("/");
  await waitForAutocomplete();
  expect(editor.isShowingAutocomplete()).toBe(true);

  for (const active of [false, true]) {
    panel.reconcile(active ? [{ state: createSubagentState("a", "worker"), activities: [] }] : []);
    for (const width of [3, 8, 40, 80]) {
      const editorLines = editor.render(width - 2);
      const lines = pane.render(width);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(lines.slice(-editorLines.length)).toEqual(editorLines.map((line) => ` ${line} `));
    }
  }
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

test("recording shortcuts distinguish presses, double taps, and bracketed paste", () => {
  vi.useFakeTimers();
  try {
    const editor = new CustomEditor(createUiTheme("plain"));
    editor.onToggleRecording = vi.fn();
    editor.setRecordingShortcut({ key: "§", gesture: "press" });
    editor.handleInput("§");
    expect(editor.onToggleRecording).toHaveBeenCalledTimes(1);
    editor.handleInput("\x1b[200~");
    editor.handleInput("§");
    editor.handleInput("\x1b[201~");
    expect(editor.onToggleRecording).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("§");
    editor.setText("");
    editor.setRecordingShortcut({ key: "§", gesture: "double-tap" });
    editor.handleInput("§");
    vi.advanceTimersByTime(100);
    editor.handleInput("§");
    expect(editor.onToggleRecording).toHaveBeenCalledTimes(2);
    expect(editor.getText()).toBe("");
    editor.onUiChange = vi.fn();
    editor.handleInput("§");
    editor.onUiChange.mockClear();
    vi.advanceTimersByTime(301);
    expect(editor.getText()).toBe("§");
    expect(editor.onUiChange).toHaveBeenCalledTimes(1);
    editor.handleInput("§");
    editor.handleInput("a");
    expect(editor.getText()).toBe("§§a");
    editor.setInputEnabled(false);
    editor.handleInput("§");
    editor.handleInput("§");
    expect(editor.onToggleRecording).toHaveBeenCalledTimes(3);
    expect(editor.getText()).toBe("§§a");
    editor.handleInput("§");
    editor.setInputEnabled(true);
    vi.advanceTimersByTime(301);
    expect(editor.getText()).toBe("§§a");
  } finally {
    vi.useRealTimers();
  }
});

test.each(["press", "double-tap"])(
  "recording shortcuts decode Kitty printable input (%s)",
  (gesture) => {
    vi.useFakeTimers();
    try {
      const editor = new CustomEditor(createUiTheme("plain"));
      editor.onToggleRecording = vi.fn();
      editor.setRecordingShortcut({ key: "A", gesture });
      editor.handleInput("\x1b[97:65;2u");
      if (gesture === "double-tap") editor.handleInput("A");
      expect(editor.onToggleRecording).toHaveBeenCalledTimes(1);
      expect(editor.getText()).toBe("");
      if (gesture === "double-tap") {
        editor.handleInput("\x1b[97:65;2u");
        vi.advanceTimersByTime(301);
        expect(editor.getText()).toBe("A");
      }
    } finally {
      vi.useRealTimers();
    }
  },
);
