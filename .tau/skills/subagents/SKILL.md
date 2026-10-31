---
name: "subagents"
description: "Decide whether subagents in Tau would help, choose assignments with clear boundaries, write self-contained handoffs, supervise running agents, and verify the combined result. Use when considering or carrying out delegation that the user or active instructions have authorized, including parallel work and independent review. Loading this skill does not authorize delegation. Trigger: balanced."
---

Delegate only when the user or active instructions allow it. When you spawn an agent, select a model only as the active model-selection policy allows. An assignment that looks small or simple is no reason to choose a different model.

You remain responsible for the overall task: its design, the decisions that shape it, and the final result. Delegation is worth it when a subagent returns something you can check and use without doing its work again.

## Decide whether to delegate

A subagent helps in four situations:

- **Context separation.** Answering a focused question needs a lot of reading or research, and you only need the answer and its evidence.
- **Concurrency.** Independent work can proceed while you or other agents do something else useful.
- **Independent judgment.** A fresh reader who has not adopted your reasoning can test a change or an explanation.
- **A better-suited model.** Models differ in strengths. A small, fast model may handle a lot of context well when it only needs to find information or point you to the right place. A stronger model can give a second opinion on a hard question. Some models are better with images or other kinds of input. Use this reason only when the user or active instructions say which model suits which kind of work. Do not guess a model's strengths from its name.

Every handoff also has costs. The agent starts without your context and has to rebuild it. You have to write the handoff, track the work, and check the result. When you already hold the relevant context, doing the work yourself is often faster, even for work that could be split. Keep quick lookups and small edits you already understand. Keep open-ended problems as well. Delegating one leaves its hard decisions unsettled and hands them to an agent with less context.

The size of an assignment matters less than its boundary. A good boundary comes from one of these:

- A specific question, for research and diagnosis.
- An agreed transformation applied to named targets, for refactors. It may span packages, layers, or repositories.
- A settled contract, for implementing a component that others will call.

If you cannot say what the agent should return and how you will check it, the assignment is not ready. Read `references/delegation-patterns.md` when choosing a boundary or planning parallel work. It pairs useful and poor assignments for research, refactoring, implementation, diagnosis, review, and fan-out.

## Plan parallel work

Run assignments in parallel only when each can make progress without waiting for another. Separate files are not enough. Two agents editing different files still collide if both depend on an interface, data format, or shared helper that is not yet decided. Settle those contracts before launch, give each shared resource one owner, and keep tightly coupled work in one assignment.

Consider the whole path to a finished result. Weigh the concurrency you gain against the context each agent must rebuild, the coordination while they run, and the review and combined verification afterwards. Split only when you still expect to finish sooner after paying those costs. Start with the fewest assignments that give the benefit. Splitting by file count adds handoffs but no independence.

When several agents edit in parallel, state who owns which files, and include your own edits in that plan. Tell each agent that others are working in the same workspace at the same time, so changes it did not make do not confuse it. Overlapping read-only work is useful when it is the point, such as an independent review or competing explanations of a failure. Say so in the handoff so the overlap is deliberate.

## Write a self-contained handoff

A subagent receives the handoff as its task input. It does not know your conversation with the user, the plan you agreed on, or what you have already ruled out. Tau supplies repository instructions such as `AGENTS.md` and discovers skills for its working directory, so you do not need to repeat those instructions. Name any skills it should use for the assignment. A reference like "the bug we discussed" means nothing to it. It usually works through to the end without asking questions, so decide in advance which ambiguities it may resolve itself and which should make it stop and report. Keep this to the cases that matter, and leave ordinary judgment to the agent.

Write for a capable colleague. Explain the intent behind the assignment and the reasons for its constraints, so the agent can make good decisions in cases you did not anticipate. State firm limits, such as read-only work or files it must not touch, plainly and with their reason. A long list of uppercase MUST and MUST NOT rules does not give the agent that understanding.

Beyond the goal and the firm limits, how much to prescribe depends on the task. Every rule, suggested method, and piece of your own reasoning in the handoff anchors the agent:

- **When you want the agent's own judgment**, as in review, diagnosis, or open research, give it the goal, the material to work from, and the firm limits, and let it choose the method. Leave out your justification for a change and your guess at a cause unless the agent cannot do the work without them. An agent that reads your reasoning first tends to confirm it.
- **When the agent must carry out a decision you have already made**, as in a wide refactor or an implementation against a settled contract, be precise. Spell out the transformation, the behavior that must stay the same, the exact targets, and the cases to report instead of resolving. Any gap in those rules is a place where the agent decides for you, and parallel agents may decide it differently.

Cover what the assignment needs:

- **Goal:** the result you need and the decision or work it feeds into.
- **Context:** relevant facts, evidence, settled decisions, and the reasons behind constraints the agent might otherwise undo. Include anything that exists only in your conversation and that the agent needs. For a review, keep back your own reasoning, as described above.
- **Scope and authority:** what to inspect or change, what to leave alone, and whether the work is read-only. State whether it may commit or act outside the workspace. Never grant more authority than you have. Tau subagents cannot spawn their own subagents.
- **Starting points:** exact paths, commands, interfaces, or sources. Give the working directory when it differs from yours.
- **Completion:** what to return, how to verify it, and which cases to report instead of resolving.

Point to source material instead of pasting whole files or transcripts. When context is long, or several agents need the same context, write it once to a file and reference that file in each handoff. This keeps the handoffs short and makes sure every agent works from the same facts. Include a worked example when the assignment repeats a transformation. Leave out history that does not affect the work, but never drop a decisive fact to keep the handoff short.

A handoff that depends on the parent conversation:

> Look into the sync ownership issue we talked about and see what you think.

A self-contained handoff for the same work:

> Investigate how repository sync detects local edits to files it manages. The answer will inform a proposed change to ownership tracking, and that change must keep preserving local edits. Start at `scripts/sync-repository.mjs` and follow the relevant imports. Work read-only: do not modify files, publish anything, or delegate further. Return the current behavior with file and function references, any gaps you can support with evidence, and open questions that would affect the proposal. Do not design the replacement.

You work mainly from the agent's final answer, so ask for a report you can act on. Waiting for an idle agent returns its latest-turn message if there is one. Read more retained text when the preview is marked incomplete; treat a failed or interrupted turn's answer as partial. Tau also keeps a trace of each agent's inputs, messages, tool calls, and tool results, but not its reasoning. Read selected parts of it when you need to check what the agent actually ran or saw, such as the output of a check it reports as passing. For research, ask for evidence and uncertainty next to each conclusion, so a short summary cannot hide the detail that changes your decision. For edits, ask for the files changed, the checks run and their results, and anything left unresolved.

Sometimes a file is a better place for the result. Ask the agent to write its findings or notes to a named path, such as a directory from `mktemp -d`, and to point to that path in its final report. Do this when the output is expected to be long, when you or later agents will use it again, or when you want detail that a final report would compress. Parallel agents can also share information through files, for example by writing findings that others read, as long as each file has one owner and the handoffs say who writes and who reads it.

## Supervise running agents

Track each assignment's owner, scope, dependencies, and status. Use Tau's agent tools to check status, wait for results, read traces, and send follow-ups. While agents run, do the independent work you planned. Waiting is reasonable when the delegated result is your next dependency.

When requirements or a contract change, tell the affected agents before they continue on stale assumptions, and spell out the new context. You can also send follow-ups that add work. Choose how each message arrives by what should happen to the current work:

- **Steer** to change the work in progress: to correct it, narrow it, or add to it. New work that fits alongside the current work is often finished sooner when you steer it in, because the agent can include it in the session it is already working on. Delivery timing depends on the worker's runtime, and steering does not stop a running tool.
- **Queue** work that should start only after the current work is done, for example because it depends on that result.
- **Interrupt** when the agent must stop its current work, for example before it makes edits that are no longer wanted. An interrupt also discards pending input, so send the new instructions after it has stopped.

Stopping an agent does not undo its file edits or external actions, so inspect the current state before giving its scope to someone else.

When an agent reports a case outside its agreed scope, make the decision yourself before widening the assignment. Agents share the workspace. Do not overwrite another agent's edits to make integration easier.

## Verify and integrate

Treat each report as a claim to check. For research, check the evidence behind the conclusions that drive important decisions. When a conclusion is low-risk or easy to correct later, trusting a well-supported report can be reasonable. Separate what the agent observed from what it inferred. For review, test each finding against the code and the conditions under which it would fail. For edits, read the actual diff, including untracked files. Confirm that it stays in scope and matches the agreed contracts. Look at which checks actually ran and what they showed.

Resolve disagreements and incompatible assumptions between agents yourself. When a result is incomplete or poorly supported, send a focused follow-up with what is missing, or do the remaining work yourself if that is faster. Then verify the combined result with the checks the repository and task call for, because pieces that pass on their own can still fail together.

Report the outcome to the user, including any uncertainty that remains.
