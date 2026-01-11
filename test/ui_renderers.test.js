import { expect, test } from "vitest";
import { renderBashExecution, renderBashRunning } from "../dist/ui/bash_execution.js";
import { renderEditSuccess, renderWriteSuccess } from "../dist/ui/file_execution.js";
import { renderGrepFinished, renderReadSuccess, renderListSuccess } from "../dist/ui/restricted_execution.js";
import { renderTaskFinished, renderTaskRunning } from "../dist/ui/task_execution.js";
import { createTagTheme, renderText } from "./ui_helpers.js";

const noPreviewTruncation = { truncated: false, totalLines: 2, outputLines: 2 };

test("renderBashRunning (compact) shows command and running status", () => {
  const theme = createTagTheme();
  const component = renderBashRunning(theme, "ls -la", true);
  const text = renderText(component, 80);
  expect(text).toContain("<bashRunning>▪</bashRunning>");
  expect(text).toContain("<accent>ls -la</accent>");
  expect(text).toContain("<muted>running</muted>");
});

test("renderBashExecution (expanded) includes output and exit code", () => {
  const theme = createTagTheme();
  const output = "output line";
  const truncationInfo = {
    output,
    model: {
      content: output,
      truncated: false,
      truncatedBy: null,
      outputLines: 1,
      outputBytes: 11,
      totalLines: 1,
      totalBytes: 11,
      maxLines: 10,
      maxTokens: 10,
    },
    captureTruncated: false,
  };
  const component = renderBashExecution(theme, "echo hi", 1, truncationInfo, undefined, false);
  const text = renderText(component, 100);
  expect(text).toContain("<bashRan><bold>$ echo hi</bold></bashRan>");
  expect(text).toContain("<bashOutput>output line</bashOutput>");
  expect(text).toContain("<warn>(exit 1)</warn>");
});

test("renderWriteSuccess (compact) shows preview lines", () => {
  const theme = createTagTheme();
  const component = renderWriteSuccess(
    theme,
    "notes.txt",
    10,
    2,
    "first\nsecond",
    true,
  );
  const text = renderText(component, 80);
  expect(text).toContain("<diffAdded>✓</diffAdded>");
  expect(text).toContain("<accent>notes.txt</accent>");
  expect(text).toContain("<dim>    first</dim>");
});

test("renderEditSuccess (expanded) highlights diffs", () => {
  const theme = createTagTheme();
  const component = renderEditSuccess(theme, "notes.txt", 10, 12, "old", "new", false);
  const text = renderText(component, 100);
  expect(text).toContain("<diffRemoved>- old</diffRemoved>");
  expect(text).toContain("<diffAdded>+ new</diffAdded>");
});

test("renderReadSuccess (compact) shows file preview", () => {
  const theme = createTagTheme();
  const component = renderReadSuccess(
    theme,
    "file.txt",
    1,
    2,
    "alpha\nbeta",
    noPreviewTruncation,
    true,
  );
  const text = renderText(component, 80);
  expect(text).toContain("<dim>    alpha</dim>");
  expect(text).toContain("<accent>file.txt</accent>");
});

test("renderListSuccess (compact) shows entries", () => {
  const theme = createTagTheme();
  const component = renderListSuccess(
    theme,
    "src",
    0,
    10,
    2,
    2,
    ["a.ts", "b.ts"],
    true,
  );
  const text = renderText(component, 80);
  expect(text).toContain("<accent>src</accent>");
  expect(text).toContain("<dim>    a.ts</dim>");
});

test("renderGrepFinished (compact) surfaces error status", () => {
  const theme = createTagTheme();
  const component = renderGrepFinished(
    theme,
    "TODO",
    "error",
    2,
    "",
    "bad file",
    false,
    true,
  );
  const text = renderText(component, 100);
  expect(text).toContain("<error>    bad file</error>");
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
  expect(finishedText).toContain("<dim>done</dim>");
  expect(finishedText).toContain("$0.12");
});
