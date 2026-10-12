---
name: "decision-review"
description: "Review a change for someone who has not read it, then guide them through product, architecture, and implementation decisions one contextual question at a time. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

## Goal

Help a decision-maker confidently approve, merge, or reject a change without reading the implementation.

First, investigate the target as thoroughly as you would in a full code review. Then turn what you learned into a guided conversation about the decisions the change makes. Start with product direction and architecture, move gradually toward implementation details, and ask exactly one question at a time.

Organize the conversation around decisions. Do not walk through files or functions unless a detail is needed to explain a material decision.

## 1. Establish the scope

The target can be any bounded change with decisions worth reviewing, such as a pull request, branch, commit, uncommitted changes, or a design. Infer it from the request. If the request does not name one, or the signals conflict, ask the user before starting. For a pull request, review the current remote state, not a possibly stale local checkout. Never overwrite uncommitted or unrelated work.

Assess the change independently, based on the code itself. Read descriptions, comments, and earlier reviews only when you need something they contain, and form your own view first so they do not shape your framing. Treat them as claims to check against the code. They show what the author intended, which is not proof of what the code does.

## 2. Understand the change before asking questions

Before the first question, understand the change from end to end. Read the full change and as much surrounding code as you need to know what problem it solves, how behavior changes, which contracts it touches, what it costs and risks, and what the tests actually prove. Keep going until you could explain it to someone else without gaps.

While you do this, actively look for problems: bugs, missing protections, implicit decisions, contradictions, and anything left half done. When the change affects persisted data, formats, or protocols, check what happens to existing data and older clients. When a conclusion depends on an external API or service, check its documentation where practical and say so when you are relying on an assumption.

Do not claim the change is safe, complete, or merge-ready until the evidence supports it.

## 3. Build a decision map

Before the first question, list the material decisions and order them from broadest to narrowest. Start with what shapes everything else, such as the purpose of the change and its effect on users. End with details that only make sense once those are settled, so the reviewer never judges a detail before understanding what it is for.

Skip trivia and decisions that the request or repository policy already settles, unless an important consequence still needs confirmation. Do not ask about the same underlying decision twice in different words.

Interfaces between components, data models, and anything an AI model sees (prompts, tool definitions, injected context) count as high-level decisions when their shape reflects a design choice. Explain their purpose and tradeoffs without turning the review into a code walkthrough.

## 4. Guide the reviewer from first principles

Assume the reviewer knows nothing about the change and should not need to open the code or the discussion. Because the conversation replaces their own reading, it must not hide important consequences.

Use the `clear-writing` skill for all communication with the user, from the first question to the final assessment, so that each explanation is easy to follow without the code.

Build their understanding step by step. Do not open with a full summary. By the end, they should be able to explain why the change exists, how it works where that matters, what it costs and risks, and how well the evidence supports it.

Keep intent, verified behavior, recommendations, and unknowns separate. Connect each question to what the reviewer already knows, and correct earlier context when later investigation changes it.

## 5. Ask one question at a time

Ask exactly one decision question per response. Never batch questions, even related ones.

Number each question as `N/T`: question `N` of an estimated `T`. If the total changes, use the new total from then on.

Use this shape:

```markdown
### Question N/T: concise decision title

Two or more short paragraphs of context explaining the current behavior, why the change takes this direction, and the meaningful tradeoff or consequence.

**Are you okay with <specific decision>?**
```

Word the question so that agreeing takes only `okay` or `yes`. Give enough context for someone who has not seen the code: define project terms, describe behavior before and after, and make hidden consequences explicit, such as effects on compatibility, security, cost, or failure behavior. Do not pressure the user to agree, and do not present an author's claim as fact without checking it.

### Surface findings as decisions

Present a real problem you found as a finding, kept separate from intentional design choices. Explain what can go wrong and when, recommend a proportionate fix, and ask, for example, **Should the change <specific fix> before approval?** Raise only findings that the change introduces and that the evidence supports.

## 6. Respond to the user

Move to the next decision once the user accepts the current one, defers it, or asks to move on. If they reply with a question, concern, or correction instead, handle it and then ask the decision again with the updated context, repeating only as much as needed.

When the user asks why something works a certain way, answer directly and check the code before defending it. If they are right, say so and correct your framing.

When the user disagrees, restate the concern concretely, investigate, explain the viable options, recommend one when the evidence supports it, and ask one question that settles the decision.

### Apply requested changes

Do not edit files just because a question was asked. Once the user requests a change or accepts a recommended fix, make it without asking again. Update everything it affects, avoid compatibility code unless it is required, verify it with a small useful check, report the result, and ask the user to confirm before moving on. If the user wants a read-only review, collect the changes and summarize them at the end.

Do not commit, push, merge, or open a pull request unless the user asks.

## 7. Finish the review

Continue until every material decision is covered, plus any detail that could change the approval decision. Do not keep asking just to be exhaustive.

Before the final assessment, make sure the reviewer can decide on their own, re-check the net change including your own edits, run the project's checks if you changed anything, and reopen accepted decisions if the target changed in a way that affects them.

### Final assessment

Keep it short. Summarize what was accepted, fixed, or deferred, how well the change is verified, whether it is ready to approve or merge, and any work still unfinished, such as uncommitted fixes. If one administrative action remains, ask only that question.
