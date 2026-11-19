import type { Api, Model } from "@earendil-works/pi-ai";

// Notes for habits a model family shows despite the shared instructions. Keep a note only
// while its models are in use and the habit still shows. Matching uses the resolved
// provider and model ID, never a persona label, because subagents and persona switches
// can change the model under the same persona.
const OPENAI_ROUTES = new Set(["openai", "openai-codex"]);

// The wording adapts OpenAI's prompting guidance for GPT-6.2, which also serves the
// earlier GPT-6 generations. Rules the shared instructions already state are left out.
const GPT_6_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
]);

export function formatModelPromptNotes(
  model: Pick<Model<Api>, "provider" | "id">,
): string | undefined {
  if (!OPENAI_ROUTES.has(model.provider) || !GPT_6_MODELS.has(model.id)) return undefined;
  return [
    "## Notes for GPT-6 models",
    "",
    `You are running on \`${model.id}\`.`,
    "",
    "- Write the final reply anew for its reader. Do not copy or closely paraphrase your reasoning or adopt its writing style.",
    "- Finish what the request authorizes before you end your turn. A request covers the steps it clearly implies, such as running the checks for a change you made, so take those steps instead of offering them, and note the assumptions you made. Offer a step only when it needs the user's go-ahead, such as committing, or when it goes beyond what they asked for.",
    "- Do not second-guess yourself, stop after describing what you could do, or give a partial answer unless there is no way to proceed.",
    "- When you write code, reuse existing classes, functions, and APIs where they keep the code correct, and keep the behavior that callers rely on unless the task changes it. Keep the code readable, and do not use fewer lines, shorter names, or dense one-liners as a substitute for simplicity.",
  ].join("\n");
}
