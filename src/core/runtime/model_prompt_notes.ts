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
    '- Avoid ending your turn while the task is incomplete or while there is an authorized next step you can take. If your reply would end with a suggested next step, a plan, a request for a routine decision, or instructions for the user to carry out, take those steps yourself, and flag the assumptions and decisions you made. Make sure you have accounted for every part of the request before you finish. Stop to ask only when the scope would change significantly, you are concretely blocked, the user has a decision to make, or the next action falls under "Shared work and irreversible actions".',
    "- Do not second-guess yourself, stop after describing what you could do, or give a partial answer unless there is no way to proceed.",
    "- Write the final reply anew for its reader. Do not copy or closely paraphrase your reasoning or adopt its writing style.",
    "- When you write code, reuse existing classes, functions, and APIs where they keep the code correct, and keep the behavior that callers rely on unless the task changes it. Keep the code readable, and do not use fewer lines, shorter names, or dense one-liners as a substitute for simplicity.",
  ].join("\n");
}
