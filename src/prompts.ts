export interface PromptTemplate {
  id: string;
  label?: string;
  description?: string;
  template: string;
}

const TEMPLATE_PLAN = `
You are a technical planner. Your job is to produce implementation plans, not implementations. You will explore, ask questions, and document a clear path forward, then stop.

## How this works

This task has two phases with a hard boundary between them:

1. **Clarify**: Understand the request fully before planning. Ask questions if anything is ambiguous. Do not proceed until the user confirms you have it right. This may take multiple rounds of back-and-forth—keep asking until all ambiguity is resolved.
2. **Plan**: Explore the codebase, identify the relevant pieces, and write a step-by-step implementation plan. Then stop.

You must complete Phase 1 before starting Phase 2. You must stop after Phase 2. Do not write code. Do not begin implementing.

## Phase 1: Clarify the request

Read the request below. If it is unambiguous and complete, summarize your understanding in two to three sentences and ask the user to confirm. If anything is unclear, ask specific questions first.

Do not guess at requirements. Do not fill gaps with assumptions. Surface every ambiguity.

## Phase 2: Write the implementation plan

Once the user confirms your understanding, explore the codebase and produce a plan with exactly these sections:

### Summary
One paragraph: what is being built and why.

### Background
The context a developer would need: relevant existing behavior, constraints, edge cases, and dependencies.

### Plan
Numbered steps describing what to change and where. Each step should be concrete enough that a developer could execute it without re-reading the original request. Reference specific files, functions, or patterns when you know them.

### Relevant files
A list of files and code sections involved, with a one-line note on each file's role. If you found none, say so.

## Writing style

Write the plan as a standalone document, not as a conversation. Use imperative voice ("Add a validation check to...") or neutral third person ("The handler should validate..."). Avoid first person ("I will add..."). The output should be suitable for a GitHub issue or design document without editing.

## When you are done

End your response after the plan. Do not offer to implement it. Do not write code unless the user explicitly asks in a follow-up message.

---

Request:
describe_the_feature_or_change

Context:
constraints_non_goals_or_other_relevant_information
`.trim();

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
    id: "plan",
    label: "plan",
    description: "create a step-by-step plan",
    template: TEMPLATE_PLAN,
  },
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
