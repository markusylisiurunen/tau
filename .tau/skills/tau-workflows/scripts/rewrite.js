// Rewrite text in the working tree so it serves its readers. Text means
// anything written for a reader, wherever it lives, such as documentation,
// agent instructions, prompts in code, or interface copy.
//
// 1. The writer works out what the text is for and who reads it, rewrites it
//    in place, deciding what each text needs as well as how to word it, and
//    writes a short, high-level brief for the readers.
// 2. Two readers look at the draft in parallel: one reads it as its intended
//    reader, and one compares what it says with the original.
// 3. The writer, continuing the same session, weighs their feedback and
//    revises. Its changes are left uncommitted.
//
// The writer owns the whole rewrite, and the readers are signals for it. The
// brief replaces a planning step, because working out the purpose and readers
// is the first part of the rewrite itself. The working tree must start clean,
// so the readers can see the rewrite as the working-tree diff.

import { input } from "@tau/core";
import {
  preflightModels,
  startRun,
  responseFormat,
  object,
  bash,
  tokens,
  log,
  ensure,
} from "./lib/workflow.js";
import {
  MODELS,
  readInputs,
  repositoryRoot,
  ensureHead,
  ensureCleanTree,
  formatBlocks,
} from "./lib/review.js";

const MAX_TARGET_TOKENS = 4096;

const BRIEF = {
  schema: object({
    brief: {
      type: "string",
      description:
        "What the text is for and who reads it, at a high level, in Markdown.",
    },
  }),
  summary: () => "brief written",
  format: ({ brief }) => brief,
};

const FEEDBACK = {
  schema: object({
    issues: {
      type: "array",
      items: object({
        title: { type: "string" },
        location: {
          type: "string",
          description: "The file and the passage it concerns.",
        },
        explanation: {
          type: "string",
          description:
            "What you noticed and why it matters for the reader, in Markdown.",
        },
      }),
    },
  }),
  summary: ({ issues }) =>
    [
      `issues=${issues.length}`,
      ...issues.map(({ title }) => `- ${title}`),
    ].join("\n"),
  format: ({ issues }) =>
    issues
      .map(
        ({ title, location, explanation }) =>
          `**${title}**\n\n**Location:** ${location}\n\n${explanation}`,
      )
      .join("\n\n") || "No issues.",
};

const REWRITE = {
  schema: object({
    changes: {
      type: "array",
      items: object({
        title: { type: "string" },
        description: {
          type: "string",
          description:
            "What you changed and why, briefly, in Markdown. Say when the text now says or asks for something different that the caller should check.",
        },
      }),
    },
    declined: {
      type: "array",
      items: object({
        feedback: {
          type: "string",
          description: "The title of the issue.",
        },
        reason: {
          type: "string",
          description:
            "Why you did not act on it, short enough to scan in a list.",
        },
      }),
    },
  }),
  summary: (result) =>
    `changes=${result.changes.length} declined=${result.declined.length}`,
  format: ({ changes, declined }) =>
    [
      `## Changes\n\n${formatBlocks(changes, "description") || "No changes."}`,
      `## Declined feedback\n\n${declined.map(({ feedback, reason }) => `- ${feedback}: ${reason}`).join("\n") || "None."}`,
    ].join("\n\n"),
};

// ── Inputs ──────────────────────────────────────────────────────────────

const { target, context, base, head, workingDirectory } = readInputs(input, {
  depth: false,
  commits: "optional",
  extra: ["target"],
});
ensure(
  typeof target === "string" &&
    target.trim() &&
    tokens(target) <= MAX_TARGET_TOKENS,
  `target must describe the text to rewrite in at most ${MAX_TARGET_TOKENS} tokens`,
);

// ── Workflow ────────────────────────────────────────────────────────────

await preflightModels([MODELS.write, MODELS.readText]);

const repo = await repositoryRoot(workingDirectory);
log(`Rewrite in ${repo}`);
if (head !== undefined) await ensureHead(repo, head);
await ensureCleanTree(repo);
const run = await startRun({ prefix: "tau-rewrite", workingDirectory: repo });

// 1. Write the first draft.
const draft = await run.turn({
  name: "write",
  model: MODELS.write,
  prompt: writerPrompt(),
  output: BRIEF,
});

// The working tree started clean, so its status lists exactly the files the
// writer changed, including new ones.
const files = (
  await bash("git status --porcelain=v1 --untracked-files=all", repo)
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3));

if (!files.length) {
  run.finish("The writer found nothing worth rewriting.");
} else {
  // 2. Read the draft. A failed reader only means less feedback, which the
  // result reports as a warning.
  const { brief } = draft.result;
  const { completed, failed } = await run.stepsInParallel([
    {
      name: "read-as-reader",
      model: MODELS.readText,
      prompt: readerPrompt(brief, files),
      output: FEEDBACK,
    },
    {
      name: "compare-meaning",
      model: MODELS.readText,
      prompt: meaningPrompt(brief, files),
      output: FEEDBACK,
    },
  ]);
  for (const name of failed) {
    run.warn(`${name} failed, so the writer did not get its feedback.`);
  }

  // 3. Revise, continuing the writer's session.
  const rewrite = await run.step({
    name: "revise",
    agentId: draft.agentId,
    prompt: revisePrompt(completed),
    output: REWRITE,
  });
  run.finish(REWRITE.format(rewrite));
}

// ── Prompts ─────────────────────────────────────────────────────────────

function scope() {
  return base === undefined
    ? ""
    : `\n\nThe target refers to the change from base ${base} to head ${head}. Use \`git diff ${base} ${head}\` to see it.`;
}

function writerPrompt() {
  return `Rewrite this text so it serves its readers: ${target}${scope()}

Text here means anything written for a reader, wherever it lives, such as documentation, agent instructions, prompts and tool descriptions in code, or interface copy. Start from what each text is for and who reads it, then from its source material, such as the code it describes. Read the repository's writing guidance in AGENTS.md, and use skill \`clear-writing\`, including its part on writing for AI models when the reader is a model.

Weigh whether each point belongs, as well as how it is worded. Text tends to grow as writers add to it, and a rewrite that only rewords keeps all of that. Keep what this reader needs to understand, decide, or act correctly, and remove what costs attention without helping them do that, such as a point made twice, an explanation of something the reader already knows, or a caveat that changes nothing. When a passage is unclear, try rewording it before adding an explanation. Keep the distinctions and reasons the reader needs, even when they take more words. The rewriting section of \`clear-writing\` keeps every point, but here removing what the reader does not need is part of the task, so name the points you removed in the changes you report.

You may change what the text asks its reader to do when that serves its purpose better. Keep the facts and the rules that protect something, such as authorization, safety, data, or a contract that other parts depend on. This is a pass over the text, and you may change code where the text needs it.

Edit the files in place, and leave a file alone when it is already good. Throughout this session, do not commit, push, or change anything on GitHub, do not launch other agents, and do not search or read Tau session history.

Two readers will then look at your draft, and you will revise it with their feedback in this same session. For them, write a short brief at a high level: what the text is for and who reads it. Leave out your own decisions and reasoning, so they judge the result for themselves.

Caller context (empty if none): ${JSON.stringify(context ?? "")}

${responseFormat(BRIEF)}`;
}

function readerPrompt(brief, files) {
  return `Read a rewritten text as its intended reader would, and report what does not work for that reader. That includes what is unclear or missing, and also what the reader could do without, such as a point made twice, an explanation of something they already know, a caveat that changes nothing they do, or wording longer than it needs to be. The rewrite is the uncommitted change in the working tree. \`git diff\` shows changes to existing files, and \`git status\` also lists new ones.

Judge the text as it reads now. Another reader compares it with the old version.

Work read-only. Do not change files, Git, or GitHub, do not launch other agents, and do not search or read Tau session history. Use skill \`clear-writing\` for the text in your response. Reporting no issues is a valid result.

Brief from the writer:
${brief}

Files: ${files.join(", ")}

${responseFormat(FEEDBACK)}`;
}

function meaningPrompt(brief, files) {
  return `Compare a rewritten text with the original, and report changes in what it says or asks of its reader that look wrong or worth rechecking, such as a fact, rule, limit, or permission that changed or disappeared. The rewrite is the uncommitted change in the working tree. \`git diff\` shows the original and the result for existing files, and \`git status\` also lists new ones.

The writer may change what the text says on purpose, including removing what its reader does not need. Report what looks like a loss or a mistake, such as a cut that took a distinction, a protective rule, or a reason the reader needs, and leave out changes that clearly serve the text.

Work read-only. Do not change files, Git, or GitHub, do not launch other agents, and do not search or read Tau session history. Use skill \`clear-writing\` for the text in your response. Reporting no issues is a valid result.

Brief from the writer:
${brief}

Files: ${files.join(", ")}

${responseFormat(FEEDBACK)}`;
}

function revisePrompt(feedback) {
  const issues = feedback.map(({ name, result }) => ({
    reader: name,
    ...result,
  }));
  const received = issues.length
    ? `Their feedback is below, as JSON grouped by reader. One read the draft as its intended reader, and the other compared what it says with the original. Treat the feedback as signals for your own judgment: act on what makes the text better, and decline the rest. Restore anything that was lost by accident.`
    : "Neither reader completed, so there is no feedback. Check the draft yourself once more.";
  return `The readers have looked at your draft. ${received}

Edit the files in place, and use skill \`clear-writing\`. When a fix overlaps a point the text already makes, change that point instead of adding another sentence. Then reread each changed text as a whole for anything it now says twice. In your response, account for every issue, so each one you did not act on is in declined.${
    issues.length
      ? `

Feedback:
${JSON.stringify(issues, null, 2)}`
      : ""
  }

${responseFormat(REWRITE)}`;
}
