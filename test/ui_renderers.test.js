import { expect, test } from "vitest";
import { renderBashExecution, renderBashRunning } from "../dist/tui/ui/bash_execution.js";
import { renderEditSuccess, renderWriteSuccess } from "../dist/tui/ui/file_execution.js";
import {
  renderGrepFinished,
  renderListSuccess,
  renderReadSuccess,
} from "../dist/tui/ui/restricted_execution.js";
import { renderTaskFinished, renderTaskRunning } from "../dist/tui/ui/task_execution.js";
import { createTagTheme, renderText } from "./ui_helpers.js";

function makeUiText(previewText, statusLine, fullText = "") {
  return { previewText, statusLine, fullText };
}

test("renderBashRunning (compact) shows command and running status", () => {
  const theme = createTagTheme();
  const component = renderBashRunning(theme, "ls -la", true);
  const text = renderText(component, 80);
  expect(text).toContain("<actionRunning>▪</actionRunning>");
  expect(text).toContain("<brandAccent>ls -la</brandAccent>");
  expect(text).toContain("<textMuted>running</textMuted>");
});

test("renderBashExecution (expanded) includes output and exit code", () => {
  const theme = createTagTheme();
  const uiText = makeUiText("    output line", "    (exit 1)", "output line\n\n(exit 1)");
  const component = renderBashExecution(theme, "echo hi", 1, uiText, false);
  const text = renderText(component, 100);
  expect(text).toContain("<actionError><bold>$ echo hi</bold></actionError>");
  expect(text).toContain("<actionError>output line");
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

test("renderReadSuccess (compact) shows file preview", () => {
  const theme = createTagTheme();
  const component = renderReadSuccess(
    theme,
    "file.txt",
    1,
    2,
    makeUiText("    alpha\n    beta", "    (2 lines · 1-2)", "alpha\nbeta"),
    true,
  );
  const text = renderText(component, 80);
  expect(text).toContain("<textDim>    alpha");
  expect(text).toContain("<textMuted>    (2 lines · 1-2)</textMuted>");
  expect(text).toContain("<brandAccent>file.txt</brandAccent>");
});

test("renderListSuccess (compact) shows entries", () => {
  const theme = createTagTheme();
  const component = renderListSuccess(
    theme,
    "src",
    makeUiText(
      "    a.ts\n    b.ts",
      "    (2 of 2 entries · offset 0 · limit 10)",
      "a.ts\nb.ts",
    ),
    true,
  );
  const text = renderText(component, 80);
  expect(text).toContain("<brandAccent>src</brandAccent>");
  expect(text).toContain("<textDim>    a.ts");
  expect(text).toContain("<textMuted>    (2 of 2 entries · offset 0 · limit 10)</textMuted>");
});

test("renderGrepFinished (compact) surfaces error status", () => {
  const theme = createTagTheme();
  const component = renderGrepFinished(
    theme,
    "TODO",
    "error",
    makeUiText("    bad file", undefined, "stderr:\nbad file"),
    true,
  );
  const text = renderText(component, 100);
  expect(text).toContain("<actionError>    bad file</actionError>");
});

test("renderTaskRunning and renderTaskFinished include cost and status", () => {
  const theme = createTagTheme();
  const running = renderTaskRunning(
    theme,
    "analysis",
    ["bash running: echo ok"],
    0.12,
    3,
    1,
    true,
  );
  const runningText = renderText(running, 120);
  expect(runningText).toContain("$ echo ok");
  expect(runningText).toContain("$0.12");

  const finished = renderTaskFinished(
    theme,
    "analysis",
    0.12,
    3,
    1,
    "success",
    "done",
    false,
  );
  const finishedText = renderText(finished, 120);
  expect(finishedText).toContain("<textDim>done</textDim>");
  expect(finishedText).toContain("$0.12");
});
