---
name: "delegate-prose"
description: "Delegate writing or editing prose to a Claude Code Opus peer that owns the editorial decisions, then verify the result. Works for any text, in files or returned to the caller; the invoking request sets the scope and what the peer may do. Use only when the user explicitly names this skill or active instructions explicitly invoke it; do not activate merely because a task involves writing. A peer that receives the writing assignment writes directly and does not delegate again. Trigger: explicit."
---

With this skill, a Claude Code Opus peer writes the text and makes the editorial decisions. Your part is to hand over the assignment and check the result.

The request or instructions that invoke this skill define the assignment: which text the peer works on, whether it edits files or returns text, and any constraints. The assignment can be any text the request asks for, including a message such as an email that the user wants written. Your own conversation with the user while you do the work is not part of the assignment, so keep writing your progress updates, questions, and reports yourself. The invocation authorizes you to delegate the assignment to one peer and grants no other permissions.

If you are the writing peer, do the assignment yourself using the `clear-writing` skill, and do not delegate it again.

## Required peer

Launch `claude-code/claude-opus-5-5:medium` through Tau's subagent support. Use exactly this model and effort level, and do not substitute another model or call the Anthropic API directly.

If the peer fails to launch or to finish, follow the fallback that the caller or the active instructions define. That fallback may tell you to write the text yourself. If they define none, report the limitation, and do not write the text yourself or delegate it to another model. Whenever you do take over the writing, state that the text did not get the Opus pass, and inspect any partial edits before you continue.

## Hand off

Delegate as soon as the source material is reliable. If the writing depends on other work, finish that work first. If the writing is the whole task, delegate right away. Do not draft the text yourself beforehand.

Some prose lives inside code, such as prompts or instructions for an AI model, or Markdown stored in a source file. When you write that code, leave the prose to the peer, for example with clearly marked placeholders, and tell the peer where it goes. What the code requires of the prose is settled, such as the values it interpolates or an output format that something parses. How much prose there is, how it is organized, and how it is worded are the peer's decisions. Ordinary code text, such as comments, docstrings, and error messages, is part of the code. Write it yourself, and do not delegate it.

The peer starts fresh in the project and knows only what your prompt tells it. Start every prompt with this preamble, and put the task-specific part after it:

> You are a writing peer for another agent that is working in this project. That agent has handed a writing task to you and will review and integrate your result. The task below states what is already settled. Every other editorial decision is yours: whether anything needs to be written or changed, what to say, where it belongs, and how to word it. Use the `clear-writing` skill. Before you write, read the project's instructions, such as `AGENTS.md` files, and follow any guidance they give on writing. Read whatever source material and surrounding text you need. If something you do not know would affect the result, ask instead of inventing facts or product decisions. Do not delegate this task to another agent. When you finish, say what you did and anything the other agent should know.

After the preamble, write a short note in plain prose, as you would to a capable colleague. Tell the peer what the work is for, what the user wants the result to achieve, and where to find the source material, and pass on everything else that is settled. Settled means what the work actually requires:

- The user's request, including any outline, length, or wording they asked for.
- Facts and decisions in the source material, such as behavior the user agreed on.
- Contracts the text must satisfy, such as the needs of the code around it.
- The caller's boundaries on what the peer may change or do.

Your own ideas about what the text should say, how it should be organized, how long it should be, or how the peer should go about the work are not settled, however sure you are of them. Leave them out. Stated as requirements, they decide the result as surely as a draft would, and the peer will follow your plan even where it would have found a better one. Point the peer to material it can read instead of summarizing it, and pass on what it cannot read, such as what the user told you in conversation. Let it read the local guidance and surrounding text itself.

This task description looks reasonable, but it decides the file, the content, and the order for the peer:

> Update `docs/queue.md` to document the new retry behavior. Add a section explaining that failed jobs are retried up to five times with exponential backoff, describe the `maxAttempts`, `baseDelay`, and `maxDelay` options, and include a note about making handlers idempotent. Keep it concise and consistent with the existing docs. Report what you changed, any uncertainties, and the checks you ran.

This task description states the change and leaves the rest to the peer:

> We added automatic retries to the job queue. The code is in `src/queue/retry.ts`, and the last commit shows the change. Update the documentation if needed.

When the peer should return text instead of editing files, say so, and pass on what the user asked for:

> Write the release note for version 2.3 and return it to me without editing any files. The readers are existing customers. The changes are listed under 2.3 in `CHANGELOG.md`, and the user asked for at most 150 words, with the breaking change first.

Give the whole writing task to a single peer. Do not split it between several peers. For follow-up requests, reuse an idle peer when practical.

## Integrate the result

Do not edit a file while the peer is editing it. Once the peer finishes, check the result for factual accuracy, scope, and fit with the rest of the work, and run the relevant checks. If an error is small and the fix is obvious, fix it yourself instead of sending it back. Send other errors back to the peer with evidence, and do not rewrite the prose in your own style. The correctness of the combined result remains your responsibility.
