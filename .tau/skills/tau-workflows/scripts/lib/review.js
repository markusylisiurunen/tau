// Shared helpers for the workflows that work on a repository's changes:
// review, improve, review-and-improve, prune, rewrite, and explain.

import { truncate } from "@tau/core";
import { bash, ensure, object, tokens } from "./workflow.js";

// Models by role, shared by these workflows. Paired reviewers use different
// models for independent views.
export const MODELS = {
  classifier: "openai-codex/gpt-6.1-terra:medium",
  codeReview: "openai-codex/gpt-6.2-astra:medium",
  codeReviewPeer: "claude-code/claude-opus-5-5:medium",
  focusedReview: "openai-codex/gpt-6.1-terra:medium",
  designReview: "claude-code/claude-opus-5-5:medium",
  designReviewPeer: "openai-codex/gpt-6.2-astra:medium",
  chooseFindings: "openai-codex/gpt-6.2-sol:high",
  gather: "openai-codex/gpt-6.2-sol:medium",
  implement: "openai-codex/gpt-6.2-astra:medium",
  find: "openai-codex/gpt-6.1-terra:medium",
  prune: "claude-code/claude-opus-5-5:medium",
  write: "claude-code/claude-opus-5-5:medium",
  readText: "claude-code/claude-opus-5-5:low",
  explain: "openai-codex/gpt-6.2-sol:medium",
};

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_FOCUS_TOKENS = 1024;
const MAX_CONTEXT_TOKENS = 4096;

export const FINDINGS = {
  schema: object({
    findings: {
      type: "array",
      items: object({
        priority: { enum: ["P0", "P1", "P2", "P3"] },
        title: {
          type: "string",
          description:
            "A short title that states the consequence in plain words.",
        },
        location: {
          type: ["string", "null"],
          description:
            "Where the problem is, such as `src/app.js:40-44`, or null if it has no single place.",
        },
        explanation: {
          type: "string",
          description:
            "When the problem happens, what goes wrong, and why it matters, in Markdown.",
        },
        suggestedFix: {
          type: "string",
          description: "The recommended fix, concrete enough to decide on, in Markdown.",
        },
      }),
    },
  }),
  summary: ({ findings }) =>
    [
      `findings=${findings.length}`,
      ...byPriority(findings).map(findingLine),
    ].join("\n"),
  format: (result) => formatFindings(result.findings),
};

// Reads the shared inputs and rejects any input the workflow does not take.
// A workflow without code-review depth passes `depth: false`, and one that
// can work without a committed change passes `commits: "optional"`. Its own
// inputs are listed in `extra` and returned as given.
export function readInputs(
  input,
  {
    depth: takesDepth = true,
    context: takesContext = true,
    commits = "required",
    extra = [],
  } = {},
) {
  const values = input ?? {};
  const known = [
    "base",
    "head",
    ...(takesContext ? ["context"] : []),
    "workingDirectory",
    ...(takesDepth ? ["depth"] : []),
    ...extra,
  ];
  const unknown = Object.keys(values).filter((key) => !known.includes(key));
  ensure(!unknown.length, `Unknown inputs: ${unknown.join(", ")}`);
  const { base, head, context, depth = "auto", workingDirectory } = values;
  ensure(
    (commits === "optional" && base === undefined && head === undefined) ||
      (COMMIT_ID.test(base) && COMMIT_ID.test(head)),
    commits === "optional"
      ? "base and head must be given together, as full lowercase commit IDs"
      : "base and head must be full lowercase commit IDs",
  );
  ensure(
    context === undefined || tokens(context) <= MAX_CONTEXT_TOKENS,
    `context must be at most ${MAX_CONTEXT_TOKENS} tokens`,
  );
  ensure(
    ["auto", "light", "standard", "deep"].includes(depth),
    "depth must be auto, light, standard, or deep",
  );
  const extras = Object.fromEntries(extra.map((key) => [key, values[key]]));
  return { base, head, context, depth, workingDirectory, ...extras };
}

export function readReviewInputs(input, { depth = true } = {}) {
  const {
    focus,
    gatherContext: gather = false,
    ...inputs
  } = readInputs(input, {
    depth,
    context: false,
    extra: ["focus", "gatherContext"],
  });
  ensure(
    focus === undefined ||
      (typeof focus === "string" && tokens(focus) <= MAX_FOCUS_TOKENS),
    `focus must be a string of at most ${MAX_FOCUS_TOKENS} tokens`,
  );
  ensure(typeof gather === "boolean", "gatherContext must be true or false");
  return { ...inputs, focus, gather };
}

export function reviewCoverage(focus) {
  return focus === undefined ? "the whole change" : "the focus";
}

export function reviewFocus(focus) {
  return focus === undefined
    ? ""
    : `\nThe caller narrowed this task to a focus: ${JSON.stringify(focus)}. Stay within that focus. Follow the code beyond it where needed to understand the change.\n`;
}

export function independentReview() {
  return `Work read-only. Do not change files, Git, or GitHub, and do not launch other agents. Do not read GitHub issues or pull request discussions, and do not search or read Tau session history.`;
}

export async function repositoryRoot(workingDirectory) {
  return (await bash("git rev-parse --show-toplevel", workingDirectory)).trim();
}

export async function ensureHead(repo, head) {
  ensure(
    (await bash("git rev-parse HEAD", repo)).trim() === head,
    "The current HEAD must match the requested head commit",
  );
}

// Untracked files count, so agents read exactly the committed files and the
// final agent's edits are the only changes.
export async function ensureCleanTree(repo) {
  const status = await bash(
    "git status --porcelain=v1 --untracked-files=normal",
    repo,
  );
  ensure(
    !status.trim(),
    `The working tree must be clean, including untracked files:\n${truncate(status, { maxChars: 4096 })}`,
  );
}

export async function diffOverview(repo, base, head) {
  const overview = await bash(
    `git diff --stat --summary --no-ext-diff ${base} ${head} --`,
    repo,
  );
  ensure(overview, "The requested commits have no diff");
  return truncate(overview, { maxChars: 16_384 });
}

export function formatFindings(findings) {
  return byPriority(findings).map(formatFinding).join("\n\n") || "No findings.";
}

// Numbered, so the user can refer to a finding in a follow-up.
function formatFinding(
  { priority, title, location, explanation, suggestedFix },
  index,
) {
  const where = location === null ? "" : `**Location:** \`${location}\`\n\n`;
  return `### ${index + 1}. [${priority}] ${title}\n\n${where}${explanation}\n\n**Suggested fix:** ${suggestedFix}`;
}

// One log detail line for a finding.
export function findingLine({ priority, title, location }) {
  return `- [${priority}] ${title}${location === null ? "" : ` (${location})`}`;
}

function byPriority(findings) {
  return [...findings].sort((a, b) => a.priority.localeCompare(b.priority));
}

// Items with a title and a Markdown body, as bold titles over paragraphs.
export function formatBlocks(items, body) {
  return items.map((item) => `**${item.title}**\n\n${item[body]}`).join("\n\n");
}

export function formatNumbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}
