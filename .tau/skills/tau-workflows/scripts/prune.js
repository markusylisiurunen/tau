// @preload ./lib/workflow.js
// @preload ./lib/review.js
//
// Prune a committed change down to what earns its place.
//
// 1. The pruner studies the change and forms its own view of what does not
//    earn its place, without editing. In parallel, three finders each look for
//    candidates from one angle: tests, defensive code, and structure and text.
// 2. The pruner, continuing the same session, weighs the finders' candidates
//    alongside its own view, decides what to prune across the whole change,
//    and makes the edits. Its changes are left uncommitted.
//
// The finders are signals, so the pruner runs even when they find nothing or
// fail. An optional focus narrows every step. Only the pruner edits files, and
// the working tree must start clean.

const {
  preflightModels,
  startRun,
  responseFormat,
  object,
  tokens,
  log,
  ensure,
} = workflow;
const {
  MODELS,
  readInputs,
  repositoryRoot,
  ensureHead,
  ensureCleanTree,
  diffOverview,
  formatBlocks,
} = review;

const MAX_FOCUS_TOKENS = 1024;

const FINDERS = [
  {
    name: "find-tests",
    model: MODELS.find,
    category:
      "Tests the change adds or changes, judged as one suite that should describe the code as it is now. Look for tests that cost more to keep than what they protect, such as tests about the change itself instead of what the code now does, tests of old behavior that the change should have updated or removed, assertions on wording or private structure, cases that repeat another case, or tests of mistakes that would fail loudly anyway.",
  },
  {
    name: "find-defensive-code",
    model: MODELS.find,
    category:
      "Defensive code the change adds. Look for protection against problems that will not happen or do not matter, such as guards for states that cannot happen, fallbacks for inputs that nothing produces, compatibility code that nothing needs, swallowed errors, or recovery paths that do not pay for themselves.",
  },
  {
    name: "find-structure",
    model: MODELS.find,
    category:
      "Structure and text the change adds. Look for structure and text that make the change bigger without making it clearer, such as layers that add nothing, options that every caller sets the same way, abstractions with one use, comments that narrate the code, documentation that repeats another source, or statements of what something does not do that no reader would assume.",
  },
];

const CANDIDATES = {
  schema: object({
    candidates: {
      type: "array",
      items: object({
        title: { type: "string" },
        location: {
          type: "string",
          description: "Where it is, such as `test/app.test.js:40-62`.",
        },
        protects: {
          type: "string",
          description:
            "The behavior it protects, or `nothing` if it protects none, and why that is or is not worth its cost.",
        },
        proposal: {
          type: "string",
          description:
            "What to remove, merge, or simplify, and what would remain, in Markdown.",
        },
      }),
    },
  }),
  summary: ({ candidates }) =>
    [
      `candidates=${candidates.length}`,
      ...candidates.map(({ title, location }) => `- ${title} (${location})`),
    ].join("\n"),
  format: ({ candidates }) =>
    candidates
      .map(
        ({ title, location, protects, proposal }) =>
          `**${title}**\n\n**Location:** \`${location}\`\n\n**Protects:** ${protects}\n\n${proposal}`,
      )
      .join("\n\n") || "No candidates.",
};

const PRUNING = {
  schema: object({
    pruned: {
      type: "array",
      items: object({
        title: { type: "string" },
        source: {
          type: "string",
          description:
            "Who found it: `you`, the finders that proposed it, or both.",
        },
        description: {
          type: "string",
          description:
            "What you removed or simplified, and any behavior that changes as a result, briefly, in Markdown.",
        },
      }),
    },
    kept: {
      type: "array",
      items: object({
        candidate: {
          type: "string",
          description: "The title of the finder's candidate.",
        },
        reason: {
          type: "string",
          description:
            "The behavior it protects, short enough to scan in a list.",
        },
      }),
      description:
        "Finders' candidates you kept because they earn their place.",
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
        "What needs a decision from a person, and checks that failed.",
    },
  }),
  summary: (result) =>
    `pruned=${result.pruned.length} kept=${result.kept.length} unresolved=${result.unresolved.length}`,
  format: ({ pruned, kept, unresolved }) =>
    [
      `## Pruned\n\n${
        formatBlocks(
          pruned.map(({ title, source, description }) => ({
            title: `${title} (found by ${source})`,
            description,
          })),
          "description",
        ) || "Nothing."
      }`,
      `## Kept\n\n${kept.map(({ candidate, reason }) => `- ${candidate}: ${reason}`).join("\n") || "None."}`,
      `## Unresolved\n\n${formatBlocks(unresolved, "description") || "None."}`,
    ].join("\n\n"),
};

// ── Inputs ──────────────────────────────────────────────────────────────

const { base, head, context, workingDirectory, focus } = readInputs(input, {
  depth: false,
  extra: ["focus"],
});
ensure(
  focus === undefined ||
    (typeof focus === "string" && tokens(focus) <= MAX_FOCUS_TOKENS),
  `focus must be a string of at most ${MAX_FOCUS_TOKENS} tokens`,
);

// ── Workflow ────────────────────────────────────────────────────────────

await preflightModels([MODELS.find, MODELS.prune]);

const repo = await repositoryRoot(workingDirectory);
log(`Prune: ${base.slice(0, 7)}..${head.slice(0, 7)} in ${repo}`);
await ensureHead(repo, head);
await ensureCleanTree(repo);
const overview = await diffOverview(repo, base, head);
const run = await startRun({ prefix: "tau-prune", workingDirectory: repo });

// 1. The pruner studies the change while the finders look for candidates. A
// failed finder only means fewer signals, which the result reports as a
// warning.
const [study, finders] = await Promise.all([
  run.turn({
    name: "study",
    model: MODELS.prune,
    prompt: studyPrompt(overview),
  }),
  run.stepsInParallel(
    FINDERS.map(({ name, category }) => ({
      name,
      model: MODELS.find,
      prompt: finderPrompt(category, overview),
      output: CANDIDATES,
    })),
  ),
]);
for (const name of finders.failed) {
  run.warn(`${name} failed, so the pruner did not get its candidates.`);
}
const candidates = finders.completed.flatMap(({ name, result }) =>
  result.candidates.map((candidate) => ({ finder: name, ...candidate })),
);

// 2. Prune, continuing the pruner's session.
await ensureHead(repo, head);
await ensureCleanTree(repo);
const pruning = await run.step({
  name: "prune",
  agentId: study.agentId,
  prompt: prunePrompt(candidates),
  output: PRUNING,
});
run.finish(PRUNING.format(pruning));

// ── Prompts ─────────────────────────────────────────────────────────────

function focusLine(finder = false) {
  if (focus === undefined) return "";
  const outside = finder
    ? " If your angle falls outside it, return no candidates."
    : "";
  return `\nThe caller limited this run to: ${JSON.stringify(focus)}. Stay within it.${outside}\n`;
}

function studyPrompt(overview) {
  return `You will prune the committed change from base ${base} to head ${head}, so it keeps only what earns its place. Everything a change adds is something to maintain, so it has to protect behavior worth that cost. Pruning may change behavior in cases that do not matter enough to keep code for, but keep the behavior that users or callers rely on.

This first turn is for understanding the change. Read the diff, the code around it, and the repository's guidance, including any testing policy in AGENTS.md. Work out what the change is for and what it needs, and form your own view of what does not earn its place, whether in tests, defensive code, structure, text, or anywhere else. Look also for parts that could do the same thing more simply, with less code.
${focusLine()}
Do not edit anything yet. Three other agents are looking for candidates in parallel, each from one angle, and you will get their candidates in the next message. End this turn with one short sentence saying you are ready.

Throughout this session, do not commit, push, or change anything on GitHub, do not launch other agents, and do not search or read Tau session history.

Caller context (empty if none): ${JSON.stringify(context ?? "")}

Diff overview:
${overview}`;
}

function finderPrompt(category, overview) {
  return `Find what the committed change from base ${base} to head ${head} adds that may not earn its place. Everything a change adds is something to maintain, so it has to protect behavior worth that cost. Agents check their changes as they work, so a test or a guard is not needed just because the code could be wrong.

Your angle: ${category}
${focusLine(true)}
Another agent decides what to prune, and your candidates are one of its signals. Propose what looks worth a closer look from your angle, and say what each candidate seems to protect, if anything. Read the repository's guidance, including any testing policy in AGENTS.md. Proposing nothing is a valid result.

Work read-only. Do not change files, Git, or GitHub, do not launch other agents, and do not search or read Tau session history. Use skill \`clear-writing\` for the text in your response.

Caller context (empty if none): ${JSON.stringify(context ?? "")}

Diff overview:
${overview}

${responseFormat(CANDIDATES)}`;
}

function prunePrompt(candidates) {
  const found = candidates.length
    ? `The other agents' candidates are below, as JSON. Each finder saw the change from one angle and can be wrong in either direction, so treat them as signals alongside your own view.`
    : "The other agents found no candidates.";
  return `${found} Decide what to prune across the whole change, then make the edits.

Judge the tests as one suite that should describe the code as it is now. Report every behavior change you make. Run the checks the repository requires.

In your response, account for every finder candidate as pruned, kept, or unresolved, and include what you pruned on your own. Use skill \`clear-writing\` for the text in your response.${
    candidates.length
      ? `

Candidates:
${JSON.stringify(candidates, null, 2)}`
      : ""
  }

${responseFormat(PRUNING)}`;
}
