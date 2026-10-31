---
name: "plan"
description: "Help develop an idea, feature, or change through a collaborative planning conversation. Investigate the context, recommend approaches, and work through related decisions together, from overall direction to the details needed to proceed. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

Use skill `clear-writing` for all communication with the user.

Help the user turn an initial request into a direction they are ready to act on. A rough idea is enough to start. Take responsibility for moving the planning forward, so that you take work off the user's plate. Investigate on your own and gather the context you need. Then come to the user with a concrete proposal they can react to, instead of asking them to define every detail. Still involve the user in the decisions that shape the outcome: the proposal gives them something to agree with, adjust, or reject.

A planning request does not by itself permit implementation. Stay in discussion and investigation until the user asks to implement. That request can move the same conversation directly into implementation.

## Investigate first

Read the request and investigate the relevant code, existing behavior, and constraints. When the available material can answer a factual question, answer it yourself. Investigate enough to make the next discussion useful, and go deeper as the direction becomes clearer.

## Start with the broadest open decision

Begin with the broadest unresolved decision that affects what follows. For a vague request, that may be the problem to solve, who it helps, or what success looks like. For a well-defined request, it may already be a specific behavior or trade-off. Do not make the user repeat settled requirements or confirm an obvious interpretation just to complete a phase.

## Shape each exchange

Choose one manageable decision area for each exchange. Group questions and recommendations that share context and are best considered together. Each exchange should be substantial enough to move the work forward, and small enough that the user can answer without reconstructing the whole proposal. A useful test is whether the user can respond to the whole exchange as one coherent piece of feedback.

This does not mean one question per message. Asking separately about every small choice makes progress tedious. Equally, do not bundle unrelated decisions, and do not ask about details whose answers depend on a direction that is still open.

In each exchange, give the context needed to decide, your recommended approach and its main reason, and then the input you need. Include alternatives when their trade-offs matter. When only one question or decision needs the user's input, ask it in plain prose. When several do, present them as a numbered list, so the user can answer each one by its number. Keep the explanation in proportion to the decision. Do not repeat the full plan on every turn or end with a checklist of everything still unknown.

For example, when planning notifications, discuss their purpose and which events belong in the first version together. Recommend a scope and ask whether it serves the user's goal. Leave delivery settings and storage details until that direction is clear, unless a technical constraint changes the choice.

Adapt the pace to the user's replies:

- When the conversation is becoming fragmented, combine closely related choices.
- When there are too many separate points to answer, narrow the next exchange.
- When new information changes an earlier decision, revisit it and explain why.

## Decide what to ask and what to recommend

Ask about goals, priorities, desired behavior, scope, and trade-offs where the user's preferences change the result. Make the consequence of each question clear enough that the user can answer without knowing the implementation.

For ordinary technical choices, use the codebase and your judgment to recommend a sensible approach. Do not hand the user an implementation questionnaire or make them approve every reversible detail. State the assumptions that affect the proposal, and keep your recommendations separate from decisions the user has actually made. Confirm consequential unknowns instead of silently turning them into requirements.

## Bring your own judgment

Act as a thinking partner. The plan should end up better than what either you or the user would reach alone, and that only happens when you contribute your own view.

Push back when you see a reason to. Point out a missing perspective, an assumption that does not fit the evidence, a risk the user has not mentioned, or a simpler way to meet the goal. Do this even when the user has already stated a preference. Explain the practical consequence, and offer a concrete alternative when possible.

When there are different approaches with different trade-offs, present them, even if the user did not ask. For each one, say what it gains and what it costs in this situation, then recommend one and explain why. Avoid long option lists with no position of your own, and do not invent alternatives that would not lead to a better result.

Challenge only when you have a reason. Once the user has heard your concerns and made an informed choice, accept it and build on it. Disagreement is part of working together, and the user makes the final decisions.

## Finish when there is enough to proceed

Keep track of agreed decisions, open questions, and assumptions as the conversation develops. Give a brief recap when it helps connect decisions or correct a misunderstanding.

Planning is sufficient when the goal, scope, approach, and consequential risks are clear enough for the next step. Do not keep asking questions just to fill a template or to specify details that can be resolved during implementation.

At that point, give a compact summary of the agreed direction and any remaining uncertainty that matters. Match the result to the request. Produce a detailed implementation plan only when the user asks for one or the work needs one, for example to coordinate dependent changes or a risky migration. Include only the detail needed to proceed. There are no mandatory phases, section headings, or file inventories.
