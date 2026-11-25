// Review a committed change, then improve it based on the reviews.
//
// 1. A classifier chooses the code-review depth and number of design reviews.
//    With `gatherContext`, a gathering agent starts collecting sources in parallel.
// 2. Independent code and design reviewers run in parallel.
// 3. A final agent weighs the completed reviews and edits the code. Its changes
//    are left uncommitted. Only this agent sees the gathered context.
//
// Only the final agent edits files, and the working tree must start clean.

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
  formatBlocks,
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
    designReviews: { enum: [0, 1, 2] },
    reasons: {
      type: "string",
      description: "Brief reasons for your choices, in Markdown.",
    },
  }),
  summary: (plan) =>
    planSummary(plan, `depth=${plan.depth} design=${plan.designReviews}`),
  format: (plan) =>
    [
      `**Depth:** ${plan.depth}, with ${plan.designReviews} design reviews`,
      plan.reasons,
      plan.scopes.length &&
        `**Focused scopes**\n\n${formatNumbered(plan.scopes)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
};

const RECOMMENDATIONS = {
  schema: object({
    recommendations: {
      type: "array",
      items: object({
        title: { type: "string" },
        explanation: {
          type: "string",
          description:
            "The edit you recommend, the affected code, and why it helps, including any change in behavior and what it gives up, in Markdown. Give enough detail that the implementer cannot misunderstand it, and no more.",
        },
      }),
    },
  }),
  summary: ({ recommendations }) =>
    [
      `recommendations=${recommendations.length}`,
      ...recommendations.map(({ title }) => `- ${title}`),
    ].join("\n"),
  format: (result) =>
    formatBlocks(result.recommendations, "explanation") ||
    "No recommendations.",
};

const IMPROVEMENT = {
  schema: object({
    changes: {
      type: "array",
      items: object({
        title: { type: "string" },
        description: {
          type: "string",
          description:
            "What you changed and why, briefly, in Markdown. Name any change in behavior.",
        },
      }),
    },
    rejected: {
      type: "array",
      items: object({
        suggestion: {
          type: "string",
          description: "The title of the finding or recommendation.",
        },
        reason: {
          type: "string",
          description:
            "Why you did not act on it, short enough to scan in a list.",
        },
      }),
      description: "Findings and recommendations you decided not to act on.",
    },
    unresolved: {
      type: "array",
      items: object({
        title: { type: "string" },
        description: {
          type: "string",
          description:
            "What is left and what decision or work it needs, in Markdown.",
        },
      }),
      description:
        "Problems you agreed with but did not resolve, decisions left to a person, and checks that failed.",
    },
  }),
  summary: (result) =>
    `changes=${result.changes.length} rejected=${result.rejected.length} unresolved=${result.unresolved.length}`,
  format: ({ changes, rejected, unresolved }) =>
    [
      `## Changes\n\n${formatBlocks(changes, "description") || "No changes."}`,
      `## Rejected suggestions\n\n${rejected.map(({ suggestion, reason }) => `- ${suggestion}: ${reason}`).join("\n") || "None."}`,
      `## Unresolved\n\n${unresolved.map(({ title, description }, index) => `### ${index + 1}. ${title}\n\n${description}`).join("\n\n") || "None."}`,
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
  MODELS.codeReviewPeer,
  MODELS.designReview,
  MODELS.designReviewPeer,
  MODELS.implement,
  ...(gather ? [MODELS.gather] : []),
  ...(["auto", "deep"].includes(depth) ? [MODELS.focusedReview] : []),
]);

const repo = await repositoryRoot(workingDirectory);
log(`Review and improve: ${base.slice(0, 7)}..${head.slice(0, 7)} in ${repo}`);
if (focus !== undefined) log(`Focus: ${oneLine(focus)}`);
await ensureHead(repo, head);
await ensureCleanTree(repo);
const overview = await diffOverview(repo, base, head);
const run = await startRun({
  prefix: "tau-review-and-improve",
  workingDirectory: repo,
});

// 1. Plan the reviews. A requested depth overrides the classifier's choice.
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
  {
    name: "code-review-1",
    model: MODELS.codeReview,
    task: fullReview(),
    output: FINDINGS,
  },
  reviewDepth !== "light" && {
    name: "code-review-2",
    model: MODELS.codeReviewPeer,
    task: fullReview(),
    output: FINDINGS,
  },
  ...scopes.map((scope, index) => ({
    name: `focused-review-${index + 1}`,
    model: MODELS.focusedReview,
    task: focusedReview(scope),
    output: FINDINGS,
  })),
  plan.designReviews >= 1 && {
    name: "design-review-1",
    model: MODELS.designReview,
    task: designReview(),
    output: RECOMMENDATIONS,
  },
  plan.designReviews === 2 && {
    name: "design-review-2",
    model: MODELS.designReviewPeer,
    task: designReview(),
    output: RECOMMENDATIONS,
  },
].filter(Boolean);
log(
  `Plan: depth=${reviewDepth}${depth === "auto" ? "" : " (requested)"}, ${reviewers.length} reviewers: ${reviewers.map(({ name }) => name).join(", ")}`,
);

// 2. Run the reviewers while gathering continues.
const [{ completed, failed }, sources] = await Promise.all([
  run.stepsInParallel(
    reviewers.map(({ name, model, task, output }) => ({
      name,
      model,
      prompt: reviewerPrompt(task, output),
      output,
    })),
  ),
  context,
]);
ensure(completed.length, "No reviewer completed. No final agent was started.");
for (const name of failed) {
  run.warn(`Review incomplete: ${name} failed, so its coverage is missing.`);
}

// 3. Weigh the reviews and edit the code.
await ensureHead(repo, head);
await ensureCleanTree(repo);
const improvement = await run.step({
  name: "improve",
  model: MODELS.implement,
  prompt: implementerPrompt(completed, sources),
  output: IMPROVEMENT,
});

run.finish(
  [
    focus !== undefined && `**Focus:** ${oneLine(focus)}`,
    IMPROVEMENT.format(improvement),
  ]
    .filter(Boolean)
    .join("\n\n"),
);

// ── Prompts ─────────────────────────────────────────────────────────────

function classifierPrompt(overview) {
  return `Plan the reviews of the committed change from base ${base} to head ${head}. Inspect the diff and surrounding code as needed. The overview below is only a starting point.

${independentReview()}
${reviewFocus(focus)}
## Code-review depth

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

## Design reviews

Choose how many independent design reviews the change needs, separately from the code-review depth: a small authorization fix may need a deep code review and no design review. A design review looks for a clearer or simpler shape, so its value depends on how many design choices the change makes and how far they reach.
- 0: no meaningful design choice, such as a mechanical change or an isolated fix.
- 1: design choices within one component, such as a new function, data shape, or local abstraction.
- 2: choices that shape how components fit together, such as boundaries, ownership, or the contracts between them.

Diff overview:
${overview}

${responseFormat(PLAN)}`;
}

function reviewerPrompt(task, output) {
  return `Inspect the committed change from base ${base} to head ${head}. Read the repository guidance and surrounding code as needed.

${independentReview()} Use skill \`clear-writing\` for the text in your response.
${reviewFocus(focus)}
Form your own understanding of the change from the code.

${task}

${responseFormat(output)}`;
}

function fullReview() {
  return `Use skill \`code-review\` to review ${reviewCoverage(focus)}, and report the findings it would raise.`;
}

function focusedReview(scope) {
  return `Use skill \`code-review\` for the assigned scope below, and report the findings it would raise. Other reviewers cover ${reviewCoverage(focus)}, so investigate this scope in more depth than a full review would, and follow the code beyond the diff where the scope requires it.

Assigned scope: ${scope}`;
}

function designReview() {
  return `Assess the change with skill \`design-afresh\`, and also check it for the code-level shortcuts that skill \`deslop\` describes. Judge whether it solves its problem clearly and is easy to maintain, and recommend the edits you would make, with code evidence. An edit may change behavior or accept a downside when that buys a clearly better implementation. Recommending no edits is a valid result.`;
}

function implementerPrompt(reviews, sources) {
  const proposals = reviews.map(({ name, result }) => ({
    reviewer: name,
    ...result,
  }));
  return `Improve the committed change from base ${base} to head ${head} using the reviews below. First confirm that HEAD still matches head and the working tree is clean, including untracked files. If either has changed, make no edits and report it as unresolved.
${reviewFocus(focus)}
The reviews contain code-review findings and design recommendations from independent reviewers. The reviewers checked them against the code, so you do not need to verify them again from scratch. Still read the code behind each one until you understand it, because a description alone is not enough to merge duplicates or plan the edits.

Decide which code-review findings to fix. Look more closely when a finding seems doubtful or reviewers disagree.
1. Merge duplicates, including findings that share one root cause and one fix.
2. Decide whether each finding is worth fixing, using the rules for qualifying findings in skill \`code-review\`. Reviewers asked to look for problems also report rare edge cases that are not worth fixing in this project. Weigh likelihood, consequence, and the cost and complexity of the fix together. Rarity alone is no reason to drop a finding with a severe consequence, an externally controllable condition, or a simple, low-risk fix. Severity labels and agreement between reviewers do not decide it, and a finding from a single reviewer can be worth fixing.

Implement the design recommendations. The design reviewers have already weighed them, including any change in behavior or downside they accept, so do not judge them again. When two recommendations conflict, choose one and reject the other.

Plan the fixes and design changes together as one coherent set of edits. A design change can fix a finding or make it obsolete, and a fix can fit the structure a recommendation introduces. Keep the fixes simple: added checks, special cases, and recovery paths must justify their complexity, and a clear error or an intentionally unsupported case can be appropriate. Beyond the recommended changes, preserve the intended behavior and established guarantees. Do not start a new review of your own.

Follow repository guidance and run appropriate checks. Do not commit, push, or change anything on GitHub, do not launch other agents. ${sources ? "Use the context folder as described below." : "Work from the code and repository alone. Do not look for other context, such as issues, pull request discussions, or Tau session history."} Use skill \`clear-writing\` for the text in your response. The unresolved items reach the user as you write them, so explain each one the way skill \`code-review\` explains a finding. Account for every finding and recommendation: each one you did not act on belongs in rejected or unresolved, so no decision is lost.

${sources ? contextSection(sources, { editing: true }) : ""}
Reviews, as JSON grouped by reviewer:
${JSON.stringify(proposals, null, 2)}

${responseFormat(IMPROVEMENT)}`;
}
