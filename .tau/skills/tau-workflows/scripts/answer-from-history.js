// @preload ./lib/workflow.js
// @preload ./lib/history.js
//
// Answer a question from past Tau sessions.
//
// 1. Select candidate sessions by time window, attribute scopes, or IDs.
// 2. Jev screens session summaries, then classifies the remaining transcripts.
// 3. A read-only agent reads the selected sessions and answers the question.
//
// With preview, the workflow stops after selection.

const {
  preflightModels,
  startRun,
  responseFormat,
  object,
  log,
  tokens,
  ensure,
} = workflow;
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
const MAX_QUESTION_TOKENS = 2048;

const RESULT = {
  schema: object({
    answer: {
      type: "string",
      description:
        "The answer, in Markdown. Cite sources inline as [1], [2], and so on, where the number is the one-based position of the session in sessionIds.",
    },
    sessionIds: {
      type: "array",
      items: { type: "string" },
      description: "The sessions the answer cites, in citation order.",
    },
  }),
  summary: (result) => `sources=${result.sessionIds.length}`,
  format: ({ answer, sessionIds }) =>
    [
      answer,
      sessionIds.map((id, index) => `- [${index + 1}]: \`${id}\``).join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
};

// ── Inputs ──────────────────────────────────────────────────────────────

const { question, preview = false } = input ?? {};
const selection = readSelection(input);
ensure(
  typeof question === "string" &&
    question.trim() &&
    tokens(question) <= MAX_QUESTION_TOKENS,
  `question must be a nonempty string of at most ${MAX_QUESTION_TOKENS} tokens`,
);

// ── Workflow ────────────────────────────────────────────────────────────

log(`Answer from history: ${describeSelection(selection)}`);
// 1. Select the candidates. A preview stops here.
const candidates = await selectCandidates(selection);
log(`Candidates: ${describeCandidates(candidates)}`);

if (preview) {
  printText(`\n${previewNote(selection)}`);
} else {
  await preflightModels(Object.values(MODELS));
  const run = await startRun({ prefix: "tau-answer-from-history" });
  await run.save("candidates.json", JSON.stringify(candidates, null, 2));

  // 2. Read the transcripts, screen summaries, and classify transcript chunks.
  const sessions = await readSessions(run, candidates, selection);
  const screened = await screen(run, sessions, {
    state: { question },
    question: screenQuestion,
  });
  const selected = await classify(run, screened, {
    state: { question },
    question: classifyQuestion(),
  });
  await run.save("selected.json", JSON.stringify(selected, null, 2));

  // 3. Read the selected sessions and write the result.
  const result = selected.length
    ? await run.step({
        name: "answer",
        model: MODELS.final,
        prompt: finalPrompt(selected),
        output: RESULT,
      })
    : null;
  run.finish(result ? RESULT.format(result) : "No relevant sessions found.");
}

// ── Prompts ─────────────────────────────────────────────────────────────

function screenQuestion(id) {
  return {
    type: "noul",
    instructions: `Could session ${id} contain information relevant to the question, even if its summary does not answer it? Keep the session when its summary or unsummarized tail suggests it might, or when you cannot tell.`,
    criteria: {
      true: "The summary or tail suggests relevant information may be present, or it is unclear.",
      false:
        "The summary and tail describe topics clearly unrelated to the question.",
    },
  };
}

function classifyQuestion() {
  return {
    type: "noul",
    instructions:
      "Does this transcript excerpt contain information that helps answer the question?",
    criteria: {
      true: "The excerpt gives a decision, proposal, fact, result, value, rationale, or evidence that bears on the answer. A partial answer, a contradiction, or a later change to an earlier answer counts.",
      false:
        "The excerpt only shares the topic, keywords, project, or people with the question, without bearing on the answer.",
    },
  };
}

function finalPrompt(selected) {
  return `Answer the question below from past Tau sessions. An automated filter selected the sessions listed below from ${describeSelection(selection)}. Read each one with the history tool. Start from its flagged entry ranges, where the filter saw possible evidence, and read around them as needed. The filter is not precise, so some selected sessions may turn out to be irrelevant.

Work read-only. Do not change files, Git, or GitHub, and do not launch other agents. Read only the sessions listed below.

Base the answer only on what you read. Distinguish proposals and open discussion from agreed decisions and completed actions, and a participant's claims from verified facts and your own inferences. When sources conflict, or a later session changed an earlier answer, say so and give the dates. If the sessions do not answer the question, say so plainly instead of guessing.

Question: ${JSON.stringify(question)}

Selected sessions, as JSON:
${JSON.stringify(selected, null, 2)}

${responseFormat(RESULT)}`;
}
