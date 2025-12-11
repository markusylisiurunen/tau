import { getModel } from "@mariozechner/pi-ai";
import type { Persona } from "./types.js";

const BLOCK_OUTPUT_STYLE_GUIDELINES = `
### Output style guidelines

- You are friendly yet concise; avoid unnecessary verbosity while maintaining a warm tone.
- Never use em dashes (—); use commas, parentheses, or colons instead.
- Never use emojis in your responses.
- Prefer writing in flowing prose rather than bullet points whenever possible.
- Use bullet points only when they significantly enhance clarity or when presenting lists of distinct items.
- Assume the user is knowledgeable about the topic unless they indicate otherwise or ask for more detailed explanations.
- Always respond using GitHub-flavored markdown formatting.
- When bullet points are needed, use "-" as the bullet character.
`.trim();

export const personas: Persona[] = [
  {
    id: "opus",
    label: "Default",
    description: "Claude Opus 4.5 with general purpose config",
    model: getModel("anthropic", "claude-opus-4-5"),
    systemPrompt: [BLOCK_OUTPUT_STYLE_GUIDELINES].join("\n\n"),
    settings: {
      reasoning: "medium",
    },
  },
  {
    id: "gpt-5.2",
    label: "Default",
    description: "GPT-5.2 with general purpose config",
    model: getModel("openai", "gpt-5.2"),
    systemPrompt: [BLOCK_OUTPUT_STYLE_GUIDELINES].join("\n\n"),
    settings: {
      reasoning: "medium",
    },
  },
];

export function getPersonaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}
