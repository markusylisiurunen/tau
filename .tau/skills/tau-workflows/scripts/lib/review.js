// @preload ./workflow.js
//
// Shared helpers for the workflows that work on a repository's changes:
// review, improve, review-and-improve, prune, and rewrite. Exposed as
// globalThis.review.

globalThis.review = (() => {
  // Models by role, shared by these workflows. Paired reviewers use different
  // models for independent views.
  const MODELS = {
    classifier: "openai-codex/gpt-6.1-terra:medium",
    codeReview: "openai-codex/gpt-6-astra:medium",
    codeReviewPeer: "claude-code/claude-opus-5-5:medium",
    focusedReview: "openai-codex/gpt-6.1-terra:medium",
    designReview: "claude-code/claude-opus-5-5:medium",
    designReviewPeer: "openai-codex/gpt-6-astra:medium",
    chooseFindings: "openai-codex/gpt-6.1-sol:medium",
    implement: "openai-codex/gpt-6-astra:medium",
    find: "openai-codex/gpt-6.1-terra:medium",
    prune: "claude-code/claude-opus-5-5:medium",
    write: "claude-code/claude-opus-5-5:medium",
    readText: "claude-code/claude-opus-5-5:low",
  };

  const { object, bash, tokens, ensure } = workflow;

  const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const MAX_CONTEXT_TOKENS = 4096;

  const FINDINGS = {
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
              "What goes wrong, when, and why it matters, in Markdown. Include a short example where it helps.",
          },
          suggestedFix: {
            type: "string",
            description: "The recommended fix, as one Markdown paragraph.",
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
  function readInputs(
    input,
    { depth: takesDepth = true, commits = "required", extra = [] } = {},
  ) {
    const values = input ?? {};
    const known = [
      "base",
      "head",
      "context",
      "workingDirectory",
      ...(takesDepth ? ["depth"] : []),
      ...extra,
    ];
    const unknown = Object.keys(values).filter((key) => !known.includes(key));
    ensure(!unknown.length, `Unknown inputs: ${unknown.join(", ")}`);
    const { base, head, context, depth = "auto", workingDirectory } = values;
    ensure(
      tau.agents && tau.bash && tau.models,
      "This workflow requires Tau's agents, bash, and models capabilities",
    );
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

  async function repositoryRoot(workingDirectory) {
    return (
      await bash("git rev-parse --show-toplevel", workingDirectory)
    ).trim();
  }

  async function ensureHead(repo, head) {
    ensure(
      (await bash("git rev-parse HEAD", repo)).trim() === head,
      "The current HEAD must match the requested head commit",
    );
  }

  // Untracked files count, so agents read exactly the committed files and the
  // final agent's edits are the only changes.
  async function ensureCleanTree(repo) {
    const status = await bash(
      "git status --porcelain=v1 --untracked-files=normal",
      repo,
    );
    ensure(
      !status.trim(),
      `The working tree must be clean, including untracked files:\n${truncate(status, { maxChars: 4096 })}`,
    );
  }

  async function diffOverview(repo, base, head) {
    const overview = await bash(
      `git diff --stat --summary --no-ext-diff ${base} ${head} --`,
      repo,
    );
    ensure(overview, "The requested commits have no diff");
    return truncate(overview, { maxChars: 16_384 });
  }

  function formatFindings(findings) {
    return (
      byPriority(findings).map(formatFinding).join("\n\n") || "No findings."
    );
  }

  function formatFinding({
    priority,
    title,
    location,
    explanation,
    suggestedFix,
  }) {
    const where = location === null ? "" : `**Location:** \`${location}\`\n\n`;
    return `**[${priority}] ${title}**\n\n${where}${explanation}\n\n**Suggested fix:** ${suggestedFix}`;
  }

  // One log detail line for a finding.
  function findingLine({ priority, title, location }) {
    return `- [${priority}] ${title}${location === null ? "" : ` (${location})`}`;
  }

  function byPriority(findings) {
    return [...findings].sort((a, b) => a.priority.localeCompare(b.priority));
  }

  // Items with a title and a Markdown body, as bold titles over paragraphs.
  function formatBlocks(items, body) {
    return items
      .map((item) => `**${item.title}**\n\n${item[body]}`)
      .join("\n\n");
  }

  function formatNumbered(items) {
    return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  }

  return {
    MODELS,
    FINDINGS,
    readInputs,
    repositoryRoot,
    ensureHead,
    ensureCleanTree,
    diffOverview,
    formatFindings,
    findingLine,
    formatBlocks,
    formatNumbered,
  };
})();
