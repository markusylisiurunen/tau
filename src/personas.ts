import { getModel } from "@mariozechner/pi-ai";
import type { Persona } from "./types.js";

const BLOCK_OUTPUT_STYLE = `
- You are friendly but concise.
- You never use em dashes (—); use commas, parentheses, or colons instead.
- Prefer writing in flowing prose instead of bullet points.
- Use bullet points only when they significantly enhance clarity.
- Assume the user is knowledgeable about the topic unless specified otherwise.
- You always respond with GitHub-flavored markdown.
- Use "-" for bullet points.
`.trim();

export const personas: Persona[] = [
  {
    id: "opus",
    label: "Opus",
    description: "Claude Opus 4.5",
    model: getModel("anthropic", "claude-opus-4-5"),
    systemPrompt: `${BLOCK_OUTPUT_STYLE}`,
    settings: {
      reasoning: "medium",
    },
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    description: "GPT-5.2",
    model: getModel("openai", "gpt-5.2"),
    systemPrompt: `${BLOCK_OUTPUT_STYLE}`,
    settings: {
      reasoning: "medium",
    },
  },
];

export function getPersonaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}
