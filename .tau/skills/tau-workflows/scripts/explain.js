// Explain a committed change to someone about to review or work with it, in a
// Markdown file or an Inko document, and refresh an existing explanation in
// place when the change has moved on.
//
// 1. The workflow ensures the destination exists: an existing or newly created
//    empty Markdown file, or an existing or newly created empty Inko document.
// 2. A single writer agent studies the change, plans the explanation, and
//    writes or updates the destination directly (with optional widgets when
//    targeting Inko).

import { input } from "@tau/core";
import * as files from "@tau/files";
import { callTool } from "@tau/mcp";
import {
  preflightModels,
  startRun,
  responseFormat,
  object,
  bash,
  log,
  ensure,
} from "./lib/workflow.js";
import {
  MODELS,
  readInputs,
  repositoryRoot,
  ensureHead,
} from "./lib/review.js";

const INKO = "inko";
const INKO_DOCUMENT =
  /^https:\/\/[^/]+\/d\/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\/?$/;

const WIDGETS = {
  type: "array",
  items: object({
    id: { type: "string" },
    teaches: {
      type: "string",
      description:
        "What the widget visualises that the text around it does not show as clearly, in one sentence.",
    },
  }),
};

function resultOutput(updating, isInko) {
  const updates = {
    type: "array",
    items: { type: "string" },
    description:
      "What you changed in the existing explanation and why, one short item each, or an empty array when it was already accurate.",
  };
  return {
    schema: object({
      summary: {
        type: "string",
        description:
          "What the change is and does, as the explanation presents it, in two or three plain sentences for the caller.",
      },
      ...(updating ? { updates } : {}),
      ...(isInko ? { widgets: WIDGETS } : {}),
    }),
    summary: ({ updates = [], widgets = [] }) => {
      const parts = [];
      if (updating) parts.push(`updates=${updates.length}`);
      if (isInko) parts.push(`widgets=${widgets.length}`);
      return [
        parts.join(" ") || "done",
        ...widgets.map(({ id, teaches }) => `- ${id}: ${teaches}`),
      ].join("\n");
    },
    format: ({ summary, updates = [], widgets = [] }) =>
      [
        summary,
        updating &&
          `## Updates\n\n${updates.map((item) => `- ${item}`).join("\n") || "No changes needed."}`,
        isInko && `## Widgets\n\n${formatWidgets(widgets)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
  };
}

function formatWidgets(widgets) {
  return (
    widgets.map(({ id, teaches }) => `- \`${id}\`: ${teaches}`).join("\n") ||
    "None."
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────

const { base, head, context, workingDirectory, output, model } = readInputs(
  input,
  {
    depth: false,
    extra: ["output", "model"],
  },
);
ensure(
  typeof output === "string" && output.trim(),
  'output must be a Markdown file path, "inko" for a new Inko document, or an Inko document URL',
);
ensure(
  model === undefined || (typeof model === "string" && model.trim()),
  "model must be a non-empty provider/model:effort string",
);
const explainModel = model?.trim() ?? MODELS.explain;
const target =
  output === INKO
    ? { kind: "inko" }
    : INKO_DOCUMENT.test(output)
      ? { kind: "inko", url: output, id: INKO_DOCUMENT.exec(output)[1] }
      : { kind: "file", path: output };
ensure(
  target.kind === "inko" || target.path.endsWith(".md"),
  'output must be a Markdown file path ending in .md, "inko", or an Inko document URL',
);

// ── Workflow ────────────────────────────────────────────────────────────

await preflightModels([explainModel]);

const repo = await repositoryRoot(workingDirectory);
log(`Explain: ${base.slice(0, 7)}..${head.slice(0, 7)} in ${repo}`);
await ensureHead(repo, head);
await ensureNoTrackedChanges(repo);

const destination = await prepareTarget();
const run = await startRun({ prefix: "tau-explain", workingDirectory: repo });
if (destination.updating) {
  log(`Refreshing ${destination.location}`);
}

const stepOutput = resultOutput(
  destination.updating,
  destination.kind === "inko",
);
const result = await run.step({
  name: "explain",
  model: explainModel,
  prompt: writerPrompt({ destination, output: stepOutput }),
  output: stepOutput,
});

run.finish(`**Explanation:** ${destination.location}\n\n${stepOutput.format(result)}`);

// ── Target preparation ──────────────────────────────────────────────────

// The agent reads the code at head from the working tree, so tracked files
// must match it. Untracked files are allowed, because the output file may
// live in the repository.
async function ensureNoTrackedChanges(repo) {
  const status = await bash(
    "git status --porcelain=v1 --untracked-files=no",
    repo,
  );
  ensure(
    !status.trim(),
    `Tracked files must have no uncommitted changes:\n${status.slice(0, 4096)}`,
  );
}

async function prepareTarget() {
  if (target.kind === "file") {
    const found = await bash(
      `test -e ${quote(target.path)} && echo yes || true`,
    );
    let updating = false;
    if (found.trim()) {
      const markdown = await files.readText(target.path);
      updating = Boolean(markdown.trim());
    } else {
      await bash(`mkdir -p "$(dirname ${quote(target.path)})"`);
      await files.writeText(target.path, "");
    }
    const location = (
      await bash(
        `cd "$(dirname ${quote(target.path)})" && printf '%s/%s' "$(pwd -P)" "$(basename ${quote(target.path)})"`,
      )
    ).trim();
    return { kind: "file", location, updating };
  }

  if (!target.id) {
    const created = await inko("create_document", {});
    log(`Created empty Inko document ${created.url}`);
    return {
      kind: "inko",
      id: created.document_id,
      location: created.url,
      updating: false,
    };
  }

  const document = await inko("read_document", { document_id: target.id });
  return {
    kind: "inko",
    id: target.id,
    location: target.url,
    updating: Boolean(document.markdown.trim()),
  };
}

async function inko(tool, args) {
  const result = await callTool(INKO, tool, args);
  const value =
    result.structuredContent ??
    JSON.parse(
      result.content.find((block) => block.type === "text")?.text ?? "null",
    );
  ensure(
    !result.isError,
    `Inko ${tool} failed: ${JSON.stringify(value?.error ?? value).slice(0, 1024)}`,
  );
  return value;
}

function quote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// ── Prompts ─────────────────────────────────────────────────────────────

function writerPrompt({ destination, output }) {
  const isInko = destination.kind === "inko";
  const targetInstruction = isInko
    ? `Write the explanation to Inko document \`${destination.id}\` (${destination.location}) using the Inko MCP server. Read the Inko MCP server's instructions and tool descriptions before writing so you follow its Markdown, revision, and widget rules. Work read-only outside of this document.`
    : `Write the explanation to \`${destination.location}\`. Work read-only outside of that file.`;

  return `Explain the committed change from base ${base} to head ${head} to a teammate who is about to review or work with it. Inspect the change with \`git diff ${base} ${head}\`. The head commit is checked out, so you can read the surrounding code as it is now. Describe the net change from base to head as one coherent whole, as if nothing happened in between, without narrating intermediate commits or how the branch evolved.

${targetInstruction}

Use skill \`clear-writing\`.

## The reader and goal

The reader is a capable engineer who knows the project, but not this change. The explanation sits between a pull request description and the raw diff. A pull request description leaves the reader reverse-engineering how the change works, while an over-detailed explanation makes them read the diff twice. Aim for the middle: after reading this, the diff should confirm what the reader expects and show them where to look closely. They should understand why the change exists, what behaves differently, how the main parts connect, and any important trade-offs, limits, or unchanged behavior that could otherwise surprise them.

## How to work

Before writing, study the diff and relevant surrounding code, decide what the reader actually needs to hear, and plan a clean top-to-bottom structure.

Order the explanation by explanatory dependency:

- Open with a \`#\` title in plain words, followed by one or two short paragraphs giving the problem, the central idea, and what becomes true after the change.
- Add sections only for distinct ideas that matter to understanding the change, establishing behavior before the contracts, lifecycle, or design choices that produce it.

## Style and level

Write like a sharp teammate explaining the change at a whiteboard: clear, natural, slightly narrative prose for reasoning and flow, balanced with structure (headings, short lists, tables, and formatting) where it makes the document easier to scan while reading the diff.

Speak in concepts, behavior, and cause so the reader never has to translate function names back into meaning. Define repo-specific terms if needed, and use file paths or symbol names only as signposts to where an idea lives. Leave routine plumbing, helper internals, and test summaries to the diff, mentioning a detail or test only when it changes how the reader should think about the change.

Keep the explanation as short as the change allows without losing clarity, and stop as soon as the mental model is complete. Length follows the number of distinct ideas, not the size of the diff: a small or single-idea change may need only a few paragraphs, and even a large change should take at most about five minutes to read.

Spare the reader from simulating behavior in their head. When a small concrete example communicates faster or more precisely than prose, such as a before-and-after data shape, API surface, configuration, prompt excerpt, or a short illustrative case with realistic values, show it. Keep examples small, make sure they accurately reflect the behavior at head, mark any omitted parts clearly, and add a brief sentence on what to notice.

Distinguish what the code does, which you can check, from why it does it, which comes from the caller's context or your own inference. Mark inferences clearly instead of stating them as fact. This is an explanation, not a review, so do not grade the change or list findings.
${isInko ? inkoSection() : fileSection()}${destination.updating ? updateSection(destination) : ""}
Caller context (empty if none): ${JSON.stringify(context ?? "")}

${responseFormat(output)}`;
}

function fileSection() {
  return `
## Format

The output is a plain Markdown file. Use standard Markdown only (prose, lists, tables, code blocks, and small text diagrams where helpful), with no widgets or interactive elements.
`;
}

function inkoSection() {
  return `
## Widgets

Because the explanation lives in Inko, you can embed HTML widgets for visualisations when seeing a structure, flow, state lifecycle, or before-and-after layout makes an idea much clearer than prose or text diagrams alone. Most changes need no widget. Keep each widget focused on one idea, make sure it accurately reflects the code at head, and keep the core explanation in the prose so the document still makes sense on its own.
`;
}

function updateSection(destination) {
  const isInko = destination.kind === "inko";
  const existing = isInko
    ? `Inko document \`${destination.id}\` already holds an earlier explanation, which people may have read, commented on, or edited. Read the document and any existing widgets through the Inko MCP server, and compare them against the full current diff from ${base} to ${head}.`
    : `\`${destination.location}\` already holds an earlier explanation, which people may have read or edited. Read it and compare it against the full current diff from ${base} to ${head}.`;
  const editsNote = isInko
    ? ", and prefer targeted edits when only parts changed"
    : "";

  return `
## Refreshing the existing explanation

${existing}

The goal is to avoid unnecessary churn while keeping the explanation fully aligned with the current change. Keep structure and wording that are still accurate so returning readers and any comments stay anchored${editsNote}. Update what the current change makes wrong, incomplete, or obsolete, remove anything that no longer applies${isInko ? " (including widgets)" : ""}, and restructure only if the change has shifted so much that the old structure no longer fits. If the existing explanation is already accurate, leave it untouched. Do not add a changelog, a "what changed" section, or revision notes.
`;
}
