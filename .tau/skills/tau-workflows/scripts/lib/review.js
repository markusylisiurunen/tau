// @preload ./workflow.js
//
// Shared helpers for the review workflows, exposed as globalThis.review.

globalThis.review = (() => {
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

  function readInputs(input) {
    const {
      base,
      head,
      context,
      depth = "auto",
      workingDirectory,
    } = input ?? {};
    ensure(
      tau.agents && tau.bash && tau.models,
      "This workflow requires Tau's agents, bash, and models capabilities",
    );
    ensure(
      COMMIT_ID.test(base) && COMMIT_ID.test(head),
      "base and head must be full lowercase commit IDs",
    );
    ensure(
      context === undefined || tokens(context) <= MAX_CONTEXT_TOKENS,
      `context must be at most ${MAX_CONTEXT_TOKENS} tokens`,
    );
    ensure(
      ["auto", "light", "standard", "deep"].includes(depth),
      "depth must be auto, light, standard, or deep",
    );
    return { base, head, context, depth, workingDirectory };
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
