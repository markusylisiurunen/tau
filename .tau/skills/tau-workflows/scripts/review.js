// Review a committed change and return the findings worth raising.
//
// 1. A classifier chooses the review depth from the diff. With `gatherContext`,
//    a gathering agent starts exporting the conversations behind the change
//    in parallel.
// 2. Independent code reviewers run in parallel. They judge the code alone,
//    without issues, discussions, or history.
// 3. A final agent merges the findings and chooses which to raise. It may
//    consult the context folder, for example to tell a deliberate change from
//    a mistake.
//
// The review covers the whole change, or only the caller's `focus` when one
// is given. Every agent works read-only, apart from the gathering agent
// writing its folder, and the working tree must be clean.

import { input } from "@tau/core";
import {
  preflightModels,
  startRun,
  responseFormat,
  object,
  log,
  oneLine,
  ensure,
} from "./lib/workflow.js";
import { contextSection, planWithContext } from "./lib/context.js";
import {
  MODELS,
  FINDINGS,
  independentReview,
  readReviewInputs,
  reviewCoverage,
  reviewFocus,
  repositoryRoot,
  ensureHead,
  ensureCleanTree,
  diffOverview,
  formatFindings,
  formatNumbered,
} from "./lib/review.js";

const PLAN = {
  schema: object({
    depth: { enum: ["light", "standard", "deep"] },
    scopes: {
      type: "array",
      items: { type: "string" },
      description:
        "One to three focused scopes for a deep review, and none otherwise.",
    },
    reasons: {
      type: "string",
      description: "Brief reasons for your choices, in Markdown.",
    },
  }),
  summary: (plan) => planSummary(plan, `depth=${plan.depth}`),
  format: (plan) =>
    [
      `**Depth:** ${plan.depth}`,
      plan.reasons,
      plan.scopes.length &&
        `**Focused scopes**\n\n${formatNumbered(plan.scopes)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
};

const ASSESSMENT = {
  schema: object({
    findings: {
      ...FINDINGS.schema.properties.findings,
      description: "The qualifying findings, ordered by priority.",
    },
    dropped: {
      type: "array",
      items: object({
        title: { type: "string" },
        reason: {
          type: "string",
          description: "Why you dropped it, short enough to scan in a list.",
        },
      }),
      description:
        "One item for each candidate you dropped. Merged duplicates need none.",
    },
  }),
  summary: (result) =>
    `kept=${result.findings.length} dropped=${result.dropped.length}`,
  format: ({ findings, dropped }) =>
    [
      `## Findings\n\n${formatFindings(findings)}`,
      `## Dropped candidates\n\n${dropped.map(({ title, reason }) => `- ${title}: ${reason}`).join("\n") || "None."}`,
    ].join("\n\n"),
};

function planSummary(plan, choice) {
  return [
    choice,
    `Reasons: ${oneLine(plan.reasons)}`,
    ...plan.scopes.map(
      (scope, index) => `Scope ${index + 1}: ${oneLine(scope)}`,
    ),
  ].join("\n");
}

// ── Inputs ──────────────────────────────────────────────────────────────

const { base, head, depth, workingDirectory, focus, gather } =
  readReviewInputs(input);

// ── Workflow ────────────────────────────────────────────────────────────

await preflightModels([
  MODELS.classifier,
  MODELS.codeReview,
  MODELS.chooseFindings,
  ...(gather ? [MODELS.gather] : []),
  ...(depth !== "light" ? [MODELS.codeReviewPeer] : []),
  ...(["auto", "deep"].includes(depth) ? [MODELS.focusedReview] : []),
]);

const repo = await repositoryRoot(workingDirectory);
log(`Review: ${base.slice(0, 7)}..${head.slice(0, 7)} in ${repo}`);
if (focus !== undefined) log(`Focus: ${oneLine(focus)}`);
await ensureHead(repo, head);
await ensureCleanTree(repo);
const overview = await diffOverview(repo, base, head);
const run = await startRun({ prefix: "tau-review", workingDirectory: repo });

// 1. Plan the review. A requested depth overrides the classifier's choice.
const { plan, context } = await planWithContext(
  run,
  { gather, base, head, repo },
  {
    name: "classify",
    model: MODELS.classifier,
    prompt: classifierPrompt(overview),
    output: PLAN,
  },
);
const reviewDepth = depth === "auto" ? plan.depth : depth;
const scopes = reviewDepth === "deep" ? plan.scopes.slice(0, 3) : [];

const reviewers = [
  { name: "code-review-1", model: MODELS.codeReview, task: fullReview() },
  reviewDepth !== "light" && {
    name: "code-review-2",
    model: MODELS.codeReviewPeer,
    task: fullReview(),
  },
  ...scopes.map((scope, index) => ({
    name: `focused-review-${index + 1}`,
    model: MODELS.focusedReview,
    task: focusedReview(scope),
  })),
].filter(Boolean);
log(
  `Plan: depth=${reviewDepth}${depth === "auto" ? "" : " (requested)"}, ${reviewers.length} reviewers: ${reviewers.map(({ name }) => name).join(", ")}`,
);

// 2. Run the reviewers while gathering continues. A failed reviewer leaves
// a coverage gap, and failed gathering leaves the final agent without context.
const [{ completed, failed }, sources] = await Promise.all([
  run.stepsInParallel(
    reviewers.map(({ name, model, task }) => ({
      name,
      model,
      prompt: reviewerPrompt(task),
      output: FINDINGS,
    })),
  ),
  context,
]);
ensure(completed.length, "No reviewer completed. No final agent was started.");
for (const name of failed) {
  run.warn(`Review incomplete: ${name} failed, so its coverage is missing.`);
}

// 3. Merge the findings and choose which to raise.
const assessment = await run.step({
  name: "assess",
  model: MODELS.chooseFindings,
  prompt: assessorPrompt(completed, sources),
  output: ASSESSMENT,
});

run.finish(
  [
    focus !== undefined && `**Focus:** ${oneLine(focus)}`,
    ASSESSMENT.format(assessment),
  ]
    .filter(Boolean)
    .join("\n\n"),
);

// ── Prompts ─────────────────────────────────────────────────────────────

function classifierPrompt(overview) {
  return `Plan the review of the committed change from base ${base} to head ${head}. Inspect the diff and surrounding code as needed. The overview below is only a starting point.

${independentReview()}
${reviewFocus(focus)}
## Review depth

Choose the depth that the risk of this change calls for. Each extra reviewer costs time and money and adds findings to weigh, and too few reviewers miss defects, so do not lean either way.
- light: one general code review. Use it when the change's effects are clear and a mistake would be easy to spot and cheap to fix. Examples include wording and documentation, renames and mechanical refactors, test-only changes, behavior changes whose cause and effect are clear, and routine dependency updates.
- standard: two independent general code reviews on different models, so one can catch what the other misses. Use it when judging correctness calls for reasoning that another reviewer could assess differently, or when a mistake would have consequences that warrant a second review. Examples include new features, logic with several cases or interactions, and changes to contracts, configuration formats, abstractions, or instructions that steer how agents act.
- deep: the two general reviews plus one to three focused reviews. Use it when the change carries a specific risk that a general review would cover only lightly, and a missed defect would be costly or hard to undo. Typical risks are security, permissions, secrets, and trust boundaries; persistence, migrations, and data deletion; concurrency and recovery; and behavior that emerges from several interacting components. The change itself must carry the risk, so touching a sensitive area is not enough. If you cannot name a concrete focused scope, choose standard.
Judge the particular change by what could go wrong, how costly it would be, and what an additional review could uncover. A behavior change or the general possibility of a dependency regression does not by itself determine the depth. Judge by risk, not size: a large mechanical change can be light, and a three-line change to an authorization check can be deep.

Requested depth: ${depth}. If it is auto, choose the depth yourself. Otherwise, use the requested depth even if you would choose differently, and mention your disagreement in your reasons.

## Focused scopes

For deep reviews, write one to three focused scopes. The general reviewers still cover ${reviewCoverage(focus)}, so each scope should name a risk that deserves a deeper, separate investigation. A scope can cover an area of code, a kind of risk, or both. Name the relevant files or concern and the risks, and leave the reviewer room to investigate and form its own conclusions. These examples show how to write a scope, not which scopes to choose:
- Review how interrupted jobs resume, including persisted state and the risk of running work twice.
- Review the new document-sharing endpoints and how they enforce permissions across users and collections.

Diff overview:
${overview}

${responseFormat(PLAN)}`;
}

function reviewerPrompt(task) {
  return `Review the committed change from base ${base} to head ${head}. Read the repository guidance and surrounding code as needed, and form your understanding of the change from the code.

${independentReview()} Use skill \`clear-writing\` for the text in your response.
${reviewFocus(focus)}
${task}

${responseFormat(FINDINGS)}`;
}

function fullReview() {
  return `Use skill \`code-review\` to review ${reviewCoverage(focus)}, and report the findings it would raise.`;
}

function focusedReview(scope) {
  return `Use skill \`code-review\` for the assigned scope below, and report the findings it would raise. Other reviewers cover ${reviewCoverage(focus)}, so investigate this scope in more depth than a full review would, and follow the code beyond the diff where the scope requires it.

Assigned scope: ${scope}`;
}

function assessorPrompt(reviews, sources) {
  const candidates = reviews.map(({ name, result }) => ({
    reviewer: name,
    findings: result.findings,
  }));
  return `Assess the candidate findings from independent reviews of the committed change from base ${base} to head ${head}, and choose which to raise.

Work read-only. Do not change files, Git, or GitHub, and do not launch other agents. ${sources ? "Use the context folder as described below." : "Judge the findings against the code and the repository alone, and do not look for other context, such as issues, pull request discussions, or Tau session history."} Use skill \`code-review\` for its rules on qualifying and explaining findings, and skill \`clear-writing\` for the text in your response. The findings you raise reach the user as you write them, as pull request comments or in a local summary.

The reviewers judged the code without issues, pull request discussions, or Tau history. Read enough of the code to understand each finding and recognize duplicates. Trust the reviewers' technical checks unless findings conflict${sources ? ", a premise looks doubtful, or the context calls it into question" : " or a premise looks doubtful"}. Check only the point that could change what you raise. Then decide what to raise:
1. Merge duplicates, including findings that share one root cause and one fix.
2. Decide whether each finding is worth raising, using the rules in \`code-review\`. Ask whether the author would act on it, given the repository's guidance, the design of the change${sources ? ", and the decisions recorded in the context folder" : ""}. Drop findings that ask for what the repository guidance rules out, such as compatibility code it says not to add. Reviewers asked to look for problems also report rare edge cases that are not worth fixing in this project. Weigh likelihood, consequence, and the cost and complexity of the fix together, including any special case the fix would add to an otherwise uniform design. Rarity alone is no reason to drop a finding with a severe consequence, an externally controllable condition, or a simple, low-risk fix. Severity labels and agreement between reviewers do not decide it, and a finding from a single reviewer can be worth raising.
3. Write each kept finding for its reader as \`code-review\` describes. The reviewers wrote for you, in the code's own terms, so rewrite their text instead of passing it on. Correct the priority where needed, and base it on the realistic consequence, and when a finding describes a cost at the code's limits, say how likely those limits are in practice.

Judge the reported findings, and do not start a new review of your own. Give a short reason for each dropped candidate, so the reader can disagree.
${focus === undefined ? "" : `\nThe caller narrowed this review to a focus: ${JSON.stringify(focus)}. Drop findings outside it.\n`}${sources ? contextSection(sources) : ""}
Candidate findings, as JSON grouped by reviewer:
${JSON.stringify(candidates, null, 2)}

${responseFormat(ASSESSMENT)}`;
}
