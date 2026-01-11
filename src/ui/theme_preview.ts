import {
  BASH_USER_MAX_STDERR_LINES,
  BASH_USER_MAX_STDERR_TOKENS,
  BASH_USER_MAX_STDOUT_LINES,
  BASH_USER_MAX_STDOUT_TOKENS,
  prepareBashOutput,
} from "../tools/bash.js";
import {
  buildBashBlockedView,
  buildBashExecutionView,
  buildBashRunningView,
} from "./bash_execution.js";
import type { ChatMessageModel } from "./chat_message_model.js";
import {
  buildEditBlockedView,
  buildEditSuccessView,
  buildWriteBlockedView,
  buildWriteSuccessView,
} from "./file_execution.js";
import {
  buildGrepBlockedView,
  buildGrepFinishedView,
  buildListBlockedView,
  buildListSuccessView,
  buildReadBlockedView,
  buildReadSuccessView,
} from "./restricted_execution.js";
import {
  buildTaskBlockedView,
  buildTaskFinishedView,
  buildTaskRunningView,
} from "./task_execution.js";
import { buildPalettePreview, type Theme } from "./theme.js";

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function buildThemePreviewMessages(theme: Theme): ChatMessageModel[] {
  const assistantMarkdown = [
    "## Theme preview",
    "Here is a mix of **bold**, *italic*, `inline code`, and a [link](https://example.com).",
    "",
    "- list item",
    "- second item",
    "",
    "> quoted text",
    "",
    "```ts",
    'const accent = palette.accent("hello");',
    "```",
  ].join("\n");

  const assistantThinking =
    "Considering contrast between muted text, user bubbles, and tool borders.";
  const assistantText = "We should increase muted contrast and brighten the accent for headers.";

  const bashStdout = [
    'src/ui/theme.ts:298:export const theme: Theme = createUiTheme("ansi");',
    "src/ui/theme.ts:299:export const palette = theme.palette;",
    "src/ui/theme.ts:300:export const markdownTheme = theme.markdownTheme;",
  ].join("\n");
  const bashStderr = "warning: theme tokens missing for tool preview";
  const bashTruncation = prepareBashOutput(bashStdout, bashStderr, false, {
    stdout: { maxLines: BASH_USER_MAX_STDOUT_LINES, maxTokens: BASH_USER_MAX_STDOUT_TOKENS },
    stderr: { maxLines: BASH_USER_MAX_STDERR_LINES, maxTokens: BASH_USER_MAX_STDERR_TOKENS },
  });

  const readContent = [
    'export const theme = createUiTheme("ansi");',
    "export const palette = theme.palette;",
    "export const markdownTheme = theme.markdownTheme;",
    "export const editorTheme = theme.editorTheme;",
  ].join("\n");
  const readLines = countLines(readContent);
  const readModelTruncation = {
    truncated: false,
    totalLines: readLines,
    outputLines: readLines,
  };

  const listEntries = ["src/app.ts", "src/ui/theme.ts", "src/ui/footer.ts", "README.md"];

  const grepStdout = ['src/ui/theme.ts:298:export const theme = createUiTheme("ansi")'].join("\n");

  const writeContent = [
    "export const previewPalette = {",
    '  accent: "#f09d4f",',
    '  muted: "#a0897a",',
    "};",
  ].join("\n");
  const writeLines = countLines(writeContent);
  const writeBytes = Buffer.byteLength(writeContent, "utf8");

  const oldText = ["const accent = 0.8;", "const muted = 0.4;"].join("\n");
  const newText = ["const accent = 0.9;", "const muted = 0.55;"].join("\n");

  return [
    { type: "system", text: "theme preview mode: model calls disabled", kind: "muted" },
    { type: "session_divider", label: "Palette" },
    { type: "assistant_partial", text: buildPalettePreview() },
    { type: "session_divider", label: "Theme Preview" },
    { type: "user", text: "Can you summarize the UI state and highlight any warnings?" },
    { type: "assistant_partial", text: assistantMarkdown },
    { type: "assistant_partial", text: assistantText, thinking: assistantThinking },
    { type: "user", text: "Remember to adjust muted contrast", isMemoryMode: true },
    { type: "system", text: "saved config to ~/.config/tau/config.json", kind: "success" },
    { type: "system", text: "risk level changed to read-only", kind: "warn" },
    { type: "system", text: "failed to load persona file", kind: "error" },
    { type: "tool", view: buildBashRunningView(theme, 'rg "theme" src') },
    {
      type: "tool",
      view: buildBashExecutionView(theme, 'rg "theme" src', 0, bashTruncation, 532),
    },
    { type: "tool", view: buildBashBlockedView(theme, "rm -rf dist", "risk level is read-only") },
    {
      type: "tool",
      view: buildReadSuccessView(
        theme,
        "src/ui/theme.ts",
        298,
        301,
        readContent,
        readModelTruncation,
      ),
    },
    {
      type: "tool",
      view: buildListSuccessView(theme, "src/ui", 0, 10, 28, listEntries.length, listEntries),
    },
    {
      type: "tool",
      view: buildReadBlockedView(theme, "/etc/shadow", "restricted tool access"),
    },
    {
      type: "tool",
      view: buildListBlockedView(theme, "/private", "restricted tool access"),
    },
    {
      type: "tool",
      view: buildGrepFinishedView(theme, "createUiTheme", "success", 0, grepStdout, "", false),
    },
    {
      type: "tool",
      view: buildGrepFinishedView(
        theme,
        "API_KEY",
        "error",
        2,
        "",
        "grep: permission denied",
        false,
      ),
    },
    {
      type: "tool",
      view: buildGrepBlockedView(theme, "API_KEY", "restricted tool access"),
    },
    {
      type: "tool",
      view: buildWriteSuccessView(
        theme,
        "src/ui/theme.preview.ts",
        writeBytes,
        writeLines,
        writeContent,
      ),
    },
    {
      type: "tool",
      view: buildWriteBlockedView(theme, "src/ui/theme.ts", "risk level is read-only"),
    },
    {
      type: "tool",
      view: buildEditSuccessView(
        theme,
        "src/ui/theme.ts",
        oldText.length,
        newText.length,
        oldText,
        newText,
      ),
    },
    {
      type: "tool",
      view: buildEditBlockedView(theme, "src/ui/theme.ts", "risk level is read-only"),
    },
    {
      type: "tool",
      view: buildTaskRunningView(
        theme,
        "Theme audit",
        ['bash running: rg "palette" src/ui', "agent: scanning UI components"],
        0.23,
        2,
        1,
        { kind: "task", subagentName: "explore" },
      ),
    },
    {
      type: "tool",
      view: buildTaskBlockedView(theme, "Web research", "risk level is read-only", {
        kind: "task",
        subagentName: "web",
      }),
    },
    {
      type: "tool",
      view: buildTaskFinishedView(
        theme,
        "Theme audit",
        0.42,
        3,
        4,
        "success",
        "Contrast issues found in muted text.\nSuggested increase: +12% lightness.",
        { kind: "task", subagentName: "explore" },
      ),
    },
    {
      type: "tool",
      view: buildTaskFinishedView(
        theme,
        "Theme audit",
        0.19,
        1,
        1,
        "error",
        "Failed to load theme tokens from config.",
        { kind: "task", subagentName: "explore" },
      ),
    },
    {
      type: "session_summary",
      summary: [
        "Summary:",
        "- Reviewed theme tokens and tool output styles",
        "- Logged warnings for missing preview colors",
        "- Suggested brighter accent and muted contrast",
      ].join("\n"),
    },
  ];
}
