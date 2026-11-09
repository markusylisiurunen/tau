// @preload ./lib/workflow.js
// @preload ./lib/history.js
//
// Find past Tau sessions that match a description.
//
// 1. Select candidate sessions by time window, attribute scopes, or IDs.
// 2. Jev screens session summaries, then classifies the remaining transcripts.
// 3. A read-only agent reads the selected sessions and lists those that match.
//
// With preview, the workflow stops after selection.

const { startRun, responseFormat, object, log, tokens, ensure } = workflow;
const {
  readSelection,
  selectCandidates,
  describeSelection,
  describeCandidates,
  previewNote,
  readSessions,
  screen,
  classify,
} = history;

const MODELS = {
  final: "openai-codex/gpt-6.1-terra:medium",
};

// Limits in tokens, estimated like Tau at six bytes per token.
const MAX_DESCRIPTION_TOKENS = 2048;

const RESULT = {
  schema: object({
    sessions: {
      type: "array",
      items: object({
        id: { type: "string", description: "The session ID." },
        reason: {
          type: "string",
          description:
            "Why the session matches, short enough to scan in a list.",
        },
      }),
      description: "The matching sessions, most relevant first.",
    },
  }),
  summary: (result) => `matches=${result.sessions.length}`,
  format: (result) =>
    result.sessions
      .map(({ id, reason }) => `- \`${id}\`: ${reason}`)
      .join("\n") || "No matching sessions found.",
};

// ── Inputs ──────────────────────────────────────────────────────────────

const { description, preview = false } = input ?? {};
const selection = readSelection(input);
ensure(
  typeof description === "string" &&
    description.trim() &&
    tokens(description) <= MAX_DESCRIPTION_TOKENS,
  `description must be a nonempty string of at most ${MAX_DESCRIPTION_TOKENS} tokens`,
);

// ── Workflow ────────────────────────────────────────────────────────────

log(`Find sessions: ${describeSelection(selection)}`);
// 1. Select the candidates. A preview stops here.
const candidates = await selectCandidates(selection);
log(`Candidates: ${describeCandidates(candidates)}`);

if (preview) {
  printText(`\n${previewNote(selection)}`);
} else {
  const run = await startRun({ prefix: "tau-find-sessions" });
  await run.save("candidates.json", JSON.stringify(candidates, null, 2));

  // 2. Read the transcripts, screen summaries, and classify transcript chunks.
  const sessions = await readSessions(run, candidates, selection);
  const screened = await screen(run, sessions, {
    state: { description },
    question: screenQuestion,
  });
  const selected = await classify(run, screened, {
    state: { description },
    question: classifyQuestion(),
  });
  await run.save("selected.json", JSON.stringify(selected, null, 2));

  // 3. Read the selected sessions and write the result.
  const result = selected.length
    ? await run.step({
        name: "find",
        model: MODELS.final,
        prompt: finalPrompt(selected),
        output: RESULT,
      })
    : null;
  run.finish(result ? RESULT.format(result) : "No matching sessions found.");
}

// ── Prompts ─────────────────────────────────────────────────────────────

function screenQuestion(id) {
  return {
    type: "noul",
    instructions: `Could session ${id} be a conversation that fits the description? Keep the session when its summary or unsummarized tail suggests it might, or when you cannot tell.`,
    criteria: {
      true: "The summary or tail suggests the conversation may fit the description, or it is unclear.",
      false: "The summary and tail clearly describe a different conversation.",
    },
  };
}

function classifyQuestion() {
  return {
    type: "noul",
    instructions:
      "Does this transcript excerpt show that the conversation fits the description? The description says what kind of conversation to find. The excerpt does not need to answer a question.",
    criteria: {
      true: "What happens in the excerpt fits the description, or a clear part of it.",
      false:
        "The excerpt only shares keywords, a project, or people with the description, or it is about different work.",
    },
  };
}

function finalPrompt(selected) {
  return `Find the past Tau sessions that match the description below. An automated filter selected the candidate sessions listed below from ${describeSelection(selection)}. Read each one with the history tool. Start from its flagged entry ranges, where the filter saw a possible match, and read around them as needed. The filter is not precise, so decide yourself whether each session matches.

Work read-only. Do not change files, Git, or GitHub, and do not launch other agents. Read only the sessions listed below.

Report the sessions that match, each with a short reason.

Description: ${JSON.stringify(description)}

Candidate sessions, as JSON:
${JSON.stringify(selected, null, 2)}

${responseFormat(RESULT)}`;
}
