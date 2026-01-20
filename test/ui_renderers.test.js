import { expect, test } from "vitest";
import { renderBashExecution, renderBashRunning } from "../dist/tui/ui/bash_execution.js";
import { renderEditSuccess, renderWriteSuccess } from "../dist/tui/ui/file_execution.js";
import { renderTaskFinished, renderTaskRunning } from "../dist/tui/ui/task_execution.js";
import { createTagTheme, renderText } from "./ui_helpers.js";

function toLines(text) {
  return text ? text.split("\n").map((line) => ({ text: line })) : [];
}

function makeUiText(previewText, statusLine, fullText = "") {
  return {
    previewLines: toLines(previewText),
    statusLine,
    fullLines: toLines(fullText),
  };
}

test("renderBashRunning (compact) shows command and running status", () => {
  const theme = createTagTheme();
  const component = renderBashRunning(theme, "ls -la", true);
  const text = renderText(component, 80);
  expect(text).toContain("<actionRunning>⏵</actionRunning>");
  expect(text).toContain("<brandAccent>ls -la</brandAccent>");
  expect(text).toContain("<textMuted>running</textMuted>");
});

test("renderBashExecution (expanded) includes output and exit code", () => {
  const theme = createTagTheme();
  const uiText = makeUiText("    output line", "    (exit 1)", "output line\n\n(exit 1)");
  const component = renderBashExecution(theme, "echo hi", 1, uiText, false);
  const text = renderText(component, 100);
  expect(text).toContain("<actionError><bold>$ echo hi</bold></actionError>");
  expect(text).toContain("<actionOutput>output line");
  expect(text).toContain("(exit 1)");
});

test("renderWriteSuccess (compact) shows preview lines", () => {
  const theme = createTagTheme();
  const component = renderWriteSuccess(
    theme,
    "notes.txt",
    makeUiText("    first\n    second", "    (2 lines)", "first\nsecond"),
    true,
  );
  const text = renderText(component, 80);
  expect(text).toContain("<actionSuccess>✓</actionSuccess>");
  expect(text).toContain("<brandAccent>notes.txt</brandAccent>");
  expect(text).toContain("<textDim>    first");
  expect(text).toContain("<textMuted>    (2 lines)</textMuted>");
});

test("renderEditSuccess (expanded) highlights diffs", () => {
  const theme = createTagTheme();
  const component = renderEditSuccess(
    theme,
    "notes.txt",
    makeUiText(
      "    - old\n    + new",
      "    (+1, -1) · replaced 3 -> 3 chars (same size)",
      "replaced 3 -> 3 chars (same size)\n\n- old\n+ new",
    ),
    false,
  );
  const text = renderText(component, 100);
  expect(text).toContain("<actionOutput>");
  expect(text).toContain("- old");
  expect(text).toContain("+ new");
});

test("renderTaskRunning and renderTaskFinished include cost and status", () => {
  const theme = createTagTheme();
  const running = renderTaskRunning(theme, "analysis", ["bash running: echo ok"], 0.12, 3, 1, true);
  const runningText = renderText(running, 120);
  expect(runningText).toContain("$ echo ok");
  expect(runningText).toContain("$0.12");

  const finished = renderTaskFinished(theme, "analysis", 0.12, 3, 1, "success", "done", false);
  const finishedText = renderText(finished, 120);
  expect(finishedText).toContain("<textDim>done</textDim>");
  expect(finishedText).toContain("$0.12");
});
