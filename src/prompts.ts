export interface PromptTemplate {
  id: string;
  label?: string;
  description?: string;
  template: string;
}

const TEMPLATE_CODE_REVIEW = `
Please review the following code. Focus on correctness, clarity, edge cases, and maintainability.

Context:
- What this code is supposed to do: <brief description>
- Any constraints or non-goals: <brief description>

Code:
\`\`\`
<paste code here>
\`\`\`

Questions:
1. What are the biggest issues or risks?
2. What improvements would you suggest (with rationale)?
3. Any tests I should add?
`.trim();

export const prompts: PromptTemplate[] = [
  {
    id: "review",
    label: "code review",
    description: "ask for a thorough code review",
    template: TEMPLATE_CODE_REVIEW,
  },
];

export function getPromptById(id: string): PromptTemplate | undefined {
  return prompts.find((p) => p.id === id);
}
