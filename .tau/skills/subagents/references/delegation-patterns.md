# Delegation patterns

Each pattern pairs a useful assignment with a poor one that looks similar. All assume delegation is authorized. Matching a category is never on its own a reason to spawn an agent. Weigh the benefit against the context, coordination, and verification the assignment adds.

## Answer one question across extensive material

Useful: trace how cancellation propagates from an HTTP request through background jobs to database calls. Ask the agent to find where propagation stops, cite the code for each step, and report uncertainty. It works read-only and does not delegate further.

The agent may read dozens of files, and you need a compact answer to one question. Keeping that reading out of your context can be worth it even if you wait for the result. Ask for the path through the system with evidence at each step, so you can check the points your decision depends on. If the trace is likely to be long, ask the agent to write it to a named file and point to that file in its final report.

Poor: "Research the backend and suggest improvements." It has no clear end and feeds no decision. A single symbol lookup is also a poor assignment for the opposite reason: you can do it faster than you can write the handoff.

## Carry out a bounded refactor

Useful: migrate callers of a deprecated client API across a named set of services. Supply the replacement contract and one worked example. Require that retry and error behavior stay the same, name the checks to run, and ask for a list of callers whose mapping is ambiguous. Precise rules matter here: the agent applies your decision across many files, so anything you leave open, it will decide on its own, possibly differently in different places.

The boundary comes from the agreed transformation, the named targets, and the checks, so it can cross packages, application layers, or repositories. One agent can own dozens of files when the change is the same throughout. Splitting it into batches by file count adds handoffs and gives every agent the same context to rebuild.

Poor: "Modernize database access." API design, transaction semantics, and error handling are all still open, and splitting the instruction into batches does not decide them. In the useful version, a caller that needs a different contract is reported back, which keeps the migration from turning into a redesign.

## Implement behind a settled interface

Useful: implement a CSV exporter after its input schema, public interface, escaping rules, and error behavior are decided. The agent owns the exporter and its focused tests, while you build the UI integration against the same contract. Tell the agent that you are editing the UI files in the same workspace at the same time.

The exporter can be checked on its own and then exercised through its caller. Ask the agent to report what it implemented, what it checked, and any input or behavior the contract did not cover.

Poor: one agent builds the exporter and another builds the caller, and each chooses the data format. You get two reasonable implementations that do not fit together. "Backend to one agent, frontend to another" becomes useful parallel work only after the contract and ownership are settled.

## Diagnose a bounded failure

Useful: find out whether a specific cache invalidation path explains a stale result. Provide the failing command, the observed output, relevant environment facts, and starting paths. Ask for a reproduction, the supporting evidence, and remaining uncertainty, and ask for no fix yet.

You get an explanation you can act on, and the diagnosis stays separate from the fix. The agent should say whether it demonstrated the cause or only found a plausible one, and report if it could not reproduce the failure.

Poor: "Fix the flaky tests" while you edit the same subsystem. The task is open-ended, and your changes can invalidate the investigation while it runs. Narrow the symptom first and keep a stable target to reproduce against, or keep the diagnosis and the related edits with one owner.

## Review a consequential change independently

Useful: review a transaction refactor for rollback behavior and resource leaks. Give the reviewer the revision or diff, the guarantees the change must keep, and permission to read surrounding code. Ask for findings with locations, the conditions under which each fails, and the consequences. Keep it read-only unless you want edits. Do not explain why you made the change or why you think it is correct, and do not tell the reviewer how to review.

The reviewer's independence is the point, so overlap with your own reading is expected. You still evaluate each finding and check any fixes it leads to.

Poor: "Confirm my fix is correct," followed by your explanation of the fix. This invites agreement and withholds what the reviewer needs to challenge you. Point it at the actual change and let it form its own understanding before it reads your reasoning.

## Fan out independent work

Fan-out runs several assignments in parallel. It applies to any of the patterns above when each assignment has enough independent work to be worth its own handoff.

Useful: several provider adapters must implement an interface that is already settled. Each agent owns one adapter and its focused tests. You own the interface and the central caller, and you update the caller while the adapters are written. Changes to shared helpers are made before launch or given to one owner. Each handoff states who owns which files and says that other agents are working in the same workspace. Each agent reports its implementation decisions, its checks, and any gaps in the contract, and you run the combined verification.

Poor: arbitrary batches of files where every agent still has to decide the new semantics, so the batches drift apart. Also poor: several agents for small edits you already understand, where writing the prompts and reconciling the results takes longer than making the edits.

Before fanning out, ask three questions. What can each agent do without waiting on another? How much context must each one rebuild? What will integration cost? If the answers leave little useful concurrency, keep the work together and do it in sequence.
