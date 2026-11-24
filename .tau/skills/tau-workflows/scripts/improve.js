// Improve the design of a committed change based on independent reviews.
//
// 1. A classifier chooses one or two design reviews.
//    With `gatherContext`, a gathering agent starts collecting sources in parallel.
// 2. Independent design reviewers run in parallel.
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
  independentReview,
  readReviewInputs,
  reviewFocus,
  repositoryRoot,
  ensureHead,
  ensureCleanTree,
  diffOverview,
  formatBlocks,
} from "./lib/review.js";

const PLAN = {
  schema: object({
    designReviews: { enum: [1, 2] },
    reasons: {
      type: "string",
      description: "Brief reasons for your choices, in Markdown.",
    },
  }),
  summary: (plan) =>
    [`design=${plan.designReviews}`, `Reasons: ${oneLine(plan.reasons)}`].join(
      "\n",
    ),
  format: (plan) =>
    [`**Design reviews:** ${plan.designReviews}`, plan.reasons]
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
          description: "The title of the recommendation.",
        },
        reason: {
          type: "string",
          description:
            "Why you did not act on it, short enough to scan in a list.",
        },
      }),
      description: "Recommendations you decided not to act on.",
    },
    unresolved: {
      type: "array",
      items: object({
        title: { type: "string" },
        description: {
          type: "string",
          description:
            "What is left and what decision or work it needs, briefly, in Markdown.",
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
      `## Unresolved\n\n${formatBlocks(unresolved, "description") || "None."}`,
    ].join("\n\n"),
};

// ── Inputs ──────────────────────────────────────────────────────────────

const { base, head, workingDirectory, focus, gather } = readReviewInputs(
  input,
  { depth: false },
);

// ── Workflow ────────────────────────────────────────────────────────────

await preflightModels([
  MODELS.classifier,
  MODELS.designReview,
  MODELS.designReviewPeer,
  MODELS.implement,
  ...(gather ? [MODELS.gather] : []),
]);

const repo = await repositoryRoot(workingDirectory);
log(`Improve: ${base.slice(0, 7)}..${head.slice(0, 7)} in ${repo}`);
if (focus !== undefined) log(`Focus: ${oneLine(focus)}`);
await ensureHead(repo, head);
await ensureCleanTree(repo);
const overview = await diffOverview(repo, base, head);
const run = await startRun({
  prefix: "tau-improve",
  workingDirectory: repo,
});

// 1. Plan the design reviews.
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
const reviewers = [
  { name: "design-review-1", model: MODELS.designReview },
  plan.designReviews === 2 && {
    name: "design-review-2",
    model: MODELS.designReviewPeer,
  },
].filter(Boolean);
log(
  `Plan: ${reviewers.length} design reviewers: ${reviewers.map(({ name }) => name).join(", ")}`,
);

// 2. Run the reviewers while gathering continues.
const [{ completed, failed }, sources] = await Promise.all([
  run.stepsInParallel(
    reviewers.map(({ name, model }) => ({
      name,
      model,
      prompt: reviewerPrompt(),
      output: RECOMMENDATIONS,
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
  return `Plan the design reviews of the committed change from base ${base} to head ${head}. Inspect the diff and surrounding code as needed. The overview below is only a starting point.

${independentReview()}
${reviewFocus(focus)}
## Design reviews

Choose one or two independent design reviews. A design review looks for a clearer or simpler shape, so its value depends on how many design choices the change makes and how far they reach. Each extra reviewer costs time and money and adds recommendations to weigh, but can see a better design that the other missed.
- 1: design choices within one component, such as a new function, data shape, or local abstraction. Also use one for mechanical changes and isolated fixes, where there may be nothing to improve.
- 2: choices that shape how components fit together, such as boundaries, ownership, or the contracts between them.

Diff overview:
${overview}

${responseFormat(PLAN)}`;
}

function reviewerPrompt() {
  return `Inspect the committed change from base ${base} to head ${head}. Read the repository guidance and surrounding code as needed.

${independentReview()} Use skill \`clear-writing\` for the text in your response.
${reviewFocus(focus)}
Form your own understanding of the change from the code.

${designReview()}

${responseFormat(RECOMMENDATIONS)}`;
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
The reviews contain design recommendations from independent reviewers. The reviewers checked them against the code, so you do not need to verify them again from scratch. Still read the code behind each one until you understand it, because a description alone is not enough to merge duplicates or plan the edits.

Implement the design recommendations. The design reviewers have already weighed them, including any change in behavior or downside they accept, so do not judge them again. When two recommendations conflict, choose one and reject the other.

Merge duplicate recommendations and plan the design changes together as one coherent set of edits. Keep the changes simple: added checks, special cases, and recovery paths must justify their complexity, and a clear error or an intentionally unsupported case can be appropriate. Beyond the recommended changes, preserve the intended behavior and established guarantees. Do not start a new review of your own.

Follow repository guidance and run appropriate checks. Do not commit, push, or change anything on GitHub, do not launch other agents. ${sources ? "Use the context folder as described below." : "Work from the code and repository alone. Do not look for other context, such as issues, pull request discussions, or Tau session history."} Use skill \`clear-writing\` for the text in your response. Account for every recommendation: each one you did not act on belongs in rejected or unresolved, so no decision is lost.

${sources ? contextSection(sources, { editing: true }) : ""}
Reviews, as JSON grouped by reviewer:
${JSON.stringify(proposals, null, 2)}

${responseFormat(IMPROVEMENT)}`;
}
