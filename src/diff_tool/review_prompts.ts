import { z } from "zod";
import type { DiffToolGuideOperationResult } from "./review_state.js";
import type { DiffToolGuide, DiffToolGuideOperation } from "./shared_types.js";
import { DIFF_TOOL_GUIDE_QUESTION_LIMIT, DIFF_TOOL_GUIDE_TOPIC_LIMIT } from "./shared_types.js";

function wrapForkSystemPrompt(lines: string[]): string {
  return ["<system>", ...lines, "</system>", ""].join("\n");
}

const REVIEW_BOOTSTRAP_PROMPT = [
  "Use the initial diff context as a starting point, then inspect the live repo state and build private working context for later review conversations in this same diff-review session.",
  "",
  "The current repo state is authoritative. Use bash as needed to inspect relevant files and commands.",
  "",
  "Reply with a compact working-memory summary covering:",
  "- the architectural shape of the change",
  "- the highest-risk behavior changes",
  "- files or areas that deserve extra scrutiny",
  "- any assumptions worth verifying in follow-up review threads",
  "",
  "This response is private working context, not reviewer-facing output.",
  "Do not write findings, recommendations, or polished review prose.",
  "Optimize for dense, specific context that will help with later diff-review requests in this conversation.",
].join("\n");

const REVIEW_GUIDE_PROMPT = [
  "Use the initial diff context as a starting point, inspect the live repo state, then create a change guide for a technically competent reviewer who has no background knowledge of this specific change set.",
  "",
  "The orientation should establish the relevant context, the problem or limitation, why the change exists, and a brief overview of the chosen approach. It may be several short paragraphs, but should stop before becoming a detailed implementation walkthrough.",
  "",
  "Choose a natural set of topics for this specific change. Each topic should explain one useful concern, subsystem, behavior, design decision, or perspective. Topics are not a fixed outline. Give each topic a distinct one-to-three-word button label, a clear heading, and a Markdown body containing the complete explanation. Use realistic examples, request shapes, state transitions, or before-and-after sketches when they communicate better than prose.",
  "",
  "Generate questions that a thoughtful reviewer would naturally ask while reading this change. Focus on incomplete mental models, design rationale, assumptions, failure behavior, compatibility, concurrency, security, and meaningful alternatives. Avoid generic checklist questions. Answer each question directly from the current code and context.",
  "",
  "Return only JSON with this exact outer shape:",
  '{"orientation":"markdown","topics":[{"label":"short text","heading":"text","body":"markdown"}],"questions":[{"question":"text","answer":"markdown"}]}',
  "",
  "The number, ordering, and explanatory form of topics and questions should fit the change. Do not wrap the JSON in a code fence.",
].join("\n");

const REVIEW_GUIDE_FORK_SYSTEM_PROMPT = wrapForkSystemPrompt([
  "From now on in this conversation, your job is to maintain a change guide for a human reviewer.",
  "Treat the earlier conversation as background context only.",
  "Do not mention the earlier conversation, hidden setup, or how you were prepared for this task.",
  "Trust the current code and diff when they differ from earlier context.",
  "Return only raw JSON in the schema requested by each message.",
]);

const COMMENT_THREAD_FORK_SYSTEM_PROMPT = wrapForkSystemPrompt([
  "From now on in this conversation, your job is to answer a focused diff-review conversation about a specific code location or question.",
  "Treat the earlier conversation as background context only.",
  "Prioritize the concrete user-visible question and the local code evidence over broad diff summaries.",
  "The reader has the diff open and already has context. Answer what was asked, at the scale it needs: most review exchanges land in a few lines, but follow the question's lead when it asks for more.",
  "Mix prose, bullets, and code naturally to make the answer easy to scan.",
  "Do not mention the earlier conversation, hidden setup, or how you were prepared for this task.",
  "If the code or diff suggests something different from the earlier conversation, trust the code and diff.",
]);

const topicSchema = z
  .object({
    label: z.string().min(1).max(32),
    heading: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();
const questionSchema = z
  .object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();
const guideResponseSchema = z
  .object({
    orientation: z.string().min(1),
    topics: z.array(topicSchema).max(DIFF_TOOL_GUIDE_TOPIC_LIMIT),
    questions: z.array(questionSchema).max(DIFF_TOOL_GUIDE_QUESTION_LIMIT),
  })
  .strict();

export type DiffReviewGuideResponse = z.infer<typeof guideResponseSchema>;

export function buildDiffReviewBootstrapPrompt(): string {
  return REVIEW_BOOTSTRAP_PROMPT;
}

export function buildDiffReviewGuidePrompt(): string {
  return `${REVIEW_GUIDE_FORK_SYSTEM_PROMPT}${REVIEW_GUIDE_PROMPT}`;
}

export function buildDiffReviewGuideOperationPrompt(
  operation: DiffToolGuideOperation,
  currentGuide: DiffToolGuide,
): string {
  const context = [
    "Use this current guide as context:",
    "",
    JSON.stringify({
      orientation: currentGuide.orientation,
      topics: currentGuide.topics,
      questions: currentGuide.questions,
    }),
    "",
  ];

  switch (operation.kind) {
    case "topic.add":
      return [
        ...context,
        `Create one new topic explaining this request: ${operation.request}`,
        'Return only JSON shaped as {"topic":{"label":"one to three words","heading":"text","body":"markdown"}}.',
      ].join("\n");
    case "topic.revise": {
      const topic = currentGuide.topics.find((entry) => entry.id === operation.topicId);
      return [
        ...context,
        `Revise this topic: ${JSON.stringify(topic)}`,
        `Revision request: ${operation.request}`,
        "Return the complete revised topic, preserving useful content that the request does not supersede.",
        'Return only JSON shaped as {"topic":{"label":"one to three words","heading":"text","body":"markdown"}}.',
      ].join("\n");
    }
    case "question.ask":
      return [
        ...context,
        `Answer this reviewer question: ${operation.question}`,
        'Return only JSON shaped as {"question":{"question":"text","answer":"markdown"}}.',
      ].join("\n");
  }
}

export function parseDiffReviewGuideResponse(response: string): DiffReviewGuideResponse {
  return parseGuideAgentResponse(response, guideResponseSchema, "guide");
}

export function parseDiffReviewGuideOperationResponse(
  operation: DiffToolGuideOperation,
  response: string,
): DiffToolGuideOperationResult {
  switch (operation.kind) {
    case "topic.add":
    case "topic.revise": {
      const content = parseGuideAgentResponse(
        response,
        z.object({ topic: topicSchema }).strict(),
        "guide topic",
      );
      return { kind: operation.kind, topic: content.topic };
    }
    case "question.ask": {
      const content = parseGuideAgentResponse(
        response,
        z.object({ question: questionSchema }).strict(),
        "guide question",
      );
      return { kind: operation.kind, question: content.question };
    }
  }
}

function parseGuideAgentResponse<T>(response: string, schema: z.ZodType<T>, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error(`${label} agent returned invalid JSON`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label} agent returned invalid content: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function buildDiffReviewCommentThreadPrompt(message: string): string {
  return `${COMMENT_THREAD_FORK_SYSTEM_PROMPT}${message}`;
}
