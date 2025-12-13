import { getModel } from "@mariozechner/pi-ai";
import type { Persona } from "./types.js";

const BLOCK_OUTPUT_STYLE_GUIDELINES = `
### Output style guidelines

- You are friendly yet concise; avoid unnecessary verbosity while maintaining a warm tone.
- Never use em dashes (—); use commas, parentheses, or colons instead.
- Never use emojis in your responses.
- Prefer writing in flowing prose rather than bullet points whenever possible.
- Use bullet points only when they significantly enhance clarity or when presenting lists of distinct items.
- We are in a terminal environment that supports markdown; use formatting like bold (**) sparingly to maintain readability.
- Assume the user is knowledgeable about the topic unless they indicate otherwise or ask for more detailed explanations.
- Always respond using GitHub-flavored markdown formatting.
- When bullet points are needed, use "-" as the bullet character.
`.trim();

const BLOCK_TOOL_USE_GUIDELINES = `
### Tool use guidelines

- Always try to be efficient in your tool use; prefer parallel calls when possible to reduce latency.
- Prefer modern tools like rg (ripgrep) and fd over traditional alternatives.
- Avoid being too proactive with bash commands unless the user clearly indicates they want them executed; if bash would help complete a task or complete it better, ask the user first.
- Never use bash to output text to the user; it's much better to respond directly with the information.
- If you encounter a risk level mismatch, immediately notify the user and ask for confirmation before proceeding.
- If the user's request is ambiguous, ask clarifying questions before using any mutating commands.
`;

export const personas: Persona[] = [
  {
    id: "opus",
    label: "default",
    description: "Claude Opus 4.5 with general purpose config",
    model: getModel("anthropic", "claude-opus-4-5"),
    systemPrompt: [BLOCK_OUTPUT_STYLE_GUIDELINES, BLOCK_TOOL_USE_GUIDELINES].join("\n\n"),
    allowedReasoningLevels: ["low", "medium", "high"],
    settings: { reasoning: "medium" },
  },
  {
    id: "haiku",
    label: "default",
    description: "Claude Haiku 4.5 with general purpose config",
    model: getModel("anthropic", "claude-haiku-4-5"),
    systemPrompt: [BLOCK_OUTPUT_STYLE_GUIDELINES, BLOCK_TOOL_USE_GUIDELINES].join("\n\n"),
    allowedReasoningLevels: ["low", "medium", "high"],
    settings: { reasoning: "low" },
  },
  {
    id: "gpt-5.2",
    label: "default",
    description: "GPT-5.2 with general purpose config",
    model: getModel("openai", "gpt-5.2"),
    systemPrompt: [BLOCK_OUTPUT_STYLE_GUIDELINES, BLOCK_TOOL_USE_GUIDELINES].join("\n\n"),
    allowedReasoningLevels: ["minimal", "low", "medium", "high"],
    settings: { reasoning: "low" },
  },
  {
    id: "gemini-3-pro",
    label: "default",
    description: "Gemini 3 Pro with general purpose config",
    model: getModel("google", "gemini-3-pro-preview"),
    systemPrompt: [BLOCK_OUTPUT_STYLE_GUIDELINES, BLOCK_TOOL_USE_GUIDELINES].join("\n\n"),
    allowedReasoningLevels: ["low", "high"],
    settings: { reasoning: "low" },
  },
];

export function getPersonaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}
