import {
  BASH_USER_MAX_STDERR_LINES,
  BASH_USER_MAX_STDERR_TOKENS,
  BASH_USER_MAX_STDOUT_LINES,
  BASH_USER_MAX_STDOUT_TOKENS,
  buildBashUiText,
  prepareBashOutput,
} from "../../../core/tools/bash.js";
import { formatTokenEstimate } from "../../../core/utils/token.js";
import {
  buildBashBlockedView,
  buildBashExecutionView,
  buildBashRunningView,
} from "../bash_execution.js";
import type { ChatMessageModel } from "../chat_message_model.js";
import {
  buildEditBlockedView,
  buildEditSuccessView,
  buildWriteBlockedView,
  buildWriteSuccessView,
} from "../file_execution.js";
import {
  buildTaskBlockedView,
  buildTaskFinishedView,
  buildTaskRunningView,
} from "../task_execution.js";
import { buildPalettePreview } from "./palette.js";
import type { Theme } from "./theme.js";

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function indentLines(lines: string[], indent = 4): string {
  if (lines.length === 0) return "";
  const pad = " ".repeat(indent);
  return lines.map((line) => `${pad}${line}`).join("\n");
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
    'const accent = palette.brandAccent("hello");',
    "```",
  ].join("\n");

  const assistantThinking =
    "Considering contrast between muted text, user bubbles, and tool borders.";
  const assistantText = "We should increase muted contrast and brighten the accent for headers.";

  const bashStdout = [
    'src/tui/ui/theme/theme.ts:182:export const theme: Theme = createUiTheme("ansi");',
    "src/tui/ui/theme/theme.ts:183:export const palette = theme.palette;",
    "src/tui/ui/theme/theme.ts:184:export const markdownTheme = theme.markdownTheme;",
  ].join("\n");
  const bashStderr = "warning: theme tokens missing for tool preview";
  const bashTruncation = prepareBashOutput(bashStdout, bashStderr, false, {
    stdout: { maxLines: BASH_USER_MAX_STDOUT_LINES, maxTokens: BASH_USER_MAX_STDOUT_TOKENS },
    stderr: { maxLines: BASH_USER_MAX_STDERR_LINES, maxTokens: BASH_USER_MAX_STDERR_TOKENS },
  });
  const bashUiText = buildBashUiText({
    truncationInfo: bashTruncation,
    exitCode: 0,
    durationMs: 532,
  });

  const writeContent = [
    "export const previewPalette = {",
    '  brandAccent: "brandAccent",',
    '  textMuted: "textMuted",',
    "};",
  ].join("\n");
  const writeLines = countLines(writeContent);
  const writeBytes = Buffer.byteLength(writeContent, "utf8");
  const writeSummary = `${writeLines} lines · ${formatTokenEstimate(writeBytes)} · ${writeBytes} bytes`;
  const writePreview = indentLines(writeContent.split("\n"));
  const writeUiText = {
    previewText: writePreview,
    statusLine: `    (${writeSummary})`,
    fullText: `${writeSummary}\n\n${writeContent}`,
  };

  const oldText = ["const brandAccent = 0.8;", "const textMuted = 0.4;"].join("\n");
  const newText = ["const brandAccent = 0.9;", "const textMuted = 0.55;"].join("\n");
  const oldLength = oldText.length;
  const newLength = newText.length;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diffLines = [
    ...oldLines.map((line) => `- ${line}`),
    ...newLines.map((line) => `+ ${line}`),
  ];
  const editPreviewLines = [...diffLines.map((line) => `    ${line}`)].join("\n");
  const sizeDiff = newLength - oldLength;
  const diffStr =
    sizeDiff === 0 ? "same size" : sizeDiff > 0 ? `+${sizeDiff} chars` : `${sizeDiff} chars`;
  const editSummary = `replaced ${oldLength} → ${newLength} chars (${diffStr})`;
  const editStatusLine = `    (+${newLines.length}, -${oldLines.length}) · ${editSummary}`;
  const editUiText = {
    previewText: editPreviewLines,
    statusLine: editStatusLine,
    fullText: `${editSummary}\n\n${diffLines.join("\n")}`,
  };

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
      view: buildBashExecutionView(theme, 'rg "theme" src', 0, bashUiText),
    },
    { type: "tool", view: buildBashBlockedView(theme, "rm -rf dist", "risk level is read-only") },
    {
      type: "tool",
      view: buildWriteSuccessView(theme, "src/tui/ui/theme/preview.ts", writeUiText),
    },
    {
      type: "tool",
      view: buildWriteBlockedView(theme, "src/tui/ui/theme/theme.ts", "risk level is read-only"),
    },
    {
      type: "tool",
      view: buildEditSuccessView(theme, "src/tui/ui/theme/theme.ts", editUiText),
    },
    {
      type: "tool",
      view: buildEditBlockedView(theme, "src/tui/ui/theme/theme.ts", "risk level is read-only"),
    },
    {
      type: "tool",
      view: buildTaskRunningView(
        theme,
        "Theme audit",
        ['bash running: rg "palette" src/tui/ui', "agent: scanning UI components"],
        0.23,
        2,
        1,
        { kind: "task", subagentName: "explore" },
      ),
    },
    {
      type: "tool",
      view: buildTaskBlockedView(theme, "Web research", "sub-agent is not enabled", {
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
