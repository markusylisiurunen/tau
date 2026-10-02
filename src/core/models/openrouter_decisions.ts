import { z } from "zod";
import { mediaValidationConstraint } from "../utils/media_validation.js";

// Nested content is already parsed JSON; preserve its arbitrary property names verbatim.
const guidance = z.custom<string | Record<string, unknown> | unknown[]>(
  (value) => typeof value === "string" || (typeof value === "object" && value !== null),
);
const namedObject = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, "__proto__"),
  { message: "expected an object without the reserved name __proto__" },
);
const probability = z.number().min(0).max(1);
const probabilities = namedObject.pipe(z.record(z.string(), probability));
const question = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("noul"),
    instructions: guidance,
    criteria: z.strictObject({ true: guidance, false: guidance }).optional(),
  }),
  z.strictObject({
    type: z.literal("choice"),
    instructions: guidance,
    criteria: namedObject
      .pipe(z.record(z.string().min(1), guidance.nullable()))
      .refine((value) => Object.keys(value).length > 0),
  }),
  z.strictObject({
    type: z.literal("score"),
    instructions: guidance,
    criteria: z.array(guidance).min(1),
  }),
]);
const decisionInput = z.strictObject({
  state: guidance,
  questions: namedObject
    .pipe(z.record(z.string().min(1), question))
    .refine((value) => Object.keys(value).length > 0),
});
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probability.optional(),
    probabilities: probabilities.optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().nonnegative(),
    confidence: probability.optional(),
    probabilities: probabilities.optional(),
    legend: namedObject.pipe(z.record(z.string(), guidance)).optional(),
  }),
]);
export const decisionResponse = z.object({
  model: z.string().min(1),
  id: z.string().optional(),
  provider: z.string().optional(),
  answers: namedObject.pipe(z.record(z.string(), answer)),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

export function parseDecisionInput(value: unknown): z.infer<typeof decisionInput> {
  const parsed = decisionInput.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid decisions input: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${mediaValidationConstraint(issue)}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export function validateDecisionAnswers(
  input: z.infer<typeof decisionInput>,
  response: z.infer<typeof decisionResponse>,
): void {
  const names = Object.keys(input.questions);
  if (names.length !== Object.keys(response.answers).length) {
    throw new Error("OpenRouter returned mismatched decision answers");
  }
  for (const [name, question] of Object.entries(input.questions)) {
    const answer = Object.hasOwn(response.answers, name) ? response.answers[name] : undefined;
    if (!answer || answer.type !== question.type) {
      throw new Error("OpenRouter returned a missing or mistyped decision answer");
    }
    if (answer.type === "choice" && question.type === "choice") {
      if (
        !Object.hasOwn(question.criteria, answer.choice) ||
        (answer.probabilities &&
          Object.keys(answer.probabilities).some((key) => !Object.hasOwn(question.criteria, key)))
      ) {
        throw new Error("OpenRouter returned an unknown decision category");
      }
    }
    if (answer.type === "score" && question.type === "score") {
      const indices = new Set(question.criteria.map((_, index) => String(index)));
      if (
        answer.score > question.criteria.length - 1 ||
        [answer.probabilities, answer.legend].some(
          (value) => value && Object.keys(value).some((key) => !indices.has(key)),
        )
      ) {
        throw new Error("OpenRouter returned a score outside the supplied rubric");
      }
    }
  }
}
