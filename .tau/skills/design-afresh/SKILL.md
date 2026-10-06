---
name: "design-afresh"
description: "Rethink a target from first principles and design it as if building it today, using top-down reasoning and abstractions that reduce cognitive load. Supports discussion, recommendations, implementation, or PR workflows as requested. Trigger: explicit."
---

This skill works on any development target: a feature, uncommitted changes, a branch, an existing library, a service, or anything else the user names. It covers existing code as much as new code, and applies equally to frontend and backend work in any language.

## Guiding principles

Three principles apply throughout the work:

- **Design for today's problem from a clean slate.** Bring along what has been learned and the constraints that are real, and leave the inherited structure behind. Choose the design on its merits, then reuse existing code where it fits. The size of the redesign is never a reason to settle for a worse outcome.
- **Build a coherent architecture with useful abstractions.** Every concept, rule, and piece of state should have a clear owner. Draw boundaries so each part can be understood on its own, and so callers never have to reconstruct internal rules or coordinate hidden dependencies.
- **Make complexity earn its place.** Preserve correctness, security, and real guarantees. Question layers, special cases, and recovery machinery that cost more than they deliver. Keep what fits, and change whatever makes the problem harder than it needs to be.

## Standard of craftsmanship

Picture a deeply experienced engineer reading the result for the first time. They value simplicity, directness, and readable code that explains itself, and they appreciate abstractions whose boundaries show a thorough understanding of the problem. They should be able to see why each piece exists and how the pieces fit together without knowing the history of the implementation. Names carry meaning, control flow is easy to follow, and interfaces make their responsibilities and correct use clear.

Aim to delight that engineer by making a difficult problem feel unexpectedly understandable. The sophistication belongs in the thinking behind the design, and reading the code should take little effort. A good abstraction is admired for the complexity it takes off its callers' hands; its ingenuity is beside the point. The result should feel straightforward without being simplistic: real complexity is handled with care, necessary distinctions stay visible, and the reader is never asked to work harder just to accommodate the implementation.

## Perspective

Codebases grow through changes that each make sense at the time. A feature slots into the nearest extension point, a fix adds a special case, a new requirement squeezes into an existing boundary. Over time these local decisions can leave a design that describes the history of the work better than the problem it now solves. Requirements change and understanding deepens, so even a well-chosen original design may stop being the best fit.

Set the current implementation aside and ask what you would build today, from a clean slate, given what is needed and known now. That includes asking which pieces should exist at all, in addition to how the existing pieces could improve. Give the existing structure little weight when choosing the design. Its value lies in what it reveals about the problem, its edge cases, and its real obligations.

The clean slate applies to design only. It is no excuse to skip understanding the existing code, and code should never be deleted before you have learned from it. The preferred design decides what survives, and the existing code does not get to decide the design.

## Follow the requested workflow

This skill provides a way of reasoning. The request that invokes it decides what to do with that reasoning: discuss, recommend, plan, implement, or open a pull request. Activating the skill does not by itself call for an approval checkpoint, a design write-up, or edits. Follow the applicable repository instructions and authorization boundaries.

Recommend a single design by default. Explore the alternatives yourself and use judgment, so the user receives a decision instead of a menu. Present alternatives when asked, and point out material uncertainty or tradeoffs whenever they affect the decision.

## Reason from the top down

### Understand the purpose

Read the applicable project guidance and inspect the target, its consumers, related contracts, and meaningful tests. When working on a change, look beyond the diff. Establish:

- The problem being solved and the outcomes that matter.
- The intended behavior, including important failure cases and invariants.
- Genuine constraints such as security, data integrity, external contracts, performance, and operational requirements.
- Which apparent requirements are merely artifacts of the current implementation.

Existing code and tests are evidence. Weigh them, but do not treat them as an unquestionable specification. Keep observed behavior separate from inferred intent. Resolve uncertainty from the available context first, and ask the user only when a consequential question remains open and the workflow allows it.

### Form a preferred design

Build your own model of the solution before organizing any critique around existing files or functions. Start with the core concepts, their responsibilities and relationships, and where ownership lies. Then shape the APIs and the flow of data, state, control, and failures. Implementation details come last.

You should be able to explain the core design in plain language: what each part owns, how the parts work together, and what a caller needs to know. Treat this as a check on your own reasoning; it does not need to appear in the output. If explaining a boundary means explaining most of what sits behind it, reconsider whether the boundary is useful.

Move freely between levels. Trace representative operations and important edge cases through the proposed design to see whether it holds up. When the details reveal something new, revise the larger model. The process is iterative, and you can inspect or try concrete code before the architecture is complete.

### Compare with the current system

Compare the preferred design with the implementation only after you have formed it. Identify where the current system already fits and where it makes the problem harder to understand or work with.

Look across corresponding operations, interfaces, and representations as well as at each one individually. Meaningful symmetry lets a reader learn a concept once and recognize it everywhere it appears. Ask whether each difference expresses a real requirement or whether reasonable local implementations have simply drifted apart. Related patterns may turn out to be one concept with intentional variations. Share meaning and decisions, and leave mere syntactic similarity alone, so unrelated things can still change independently. The aim is a coherent model; uniformity has no value on its own.

Use the comparison to decide what to reuse and what to change, and do not let it pull the preferred design back toward the easiest patch. A materially better outcome can justify a substantial refactor or redesign, and neither past effort nor the amount of code involved is a reason to keep a weaker design. Honor any explicit scope or delivery constraints, but do not invent a preference for small diffs. Reuse what genuinely fits, and treat neither preservation nor replacement as a goal in itself.

The target is where the work starts, and its boundary does not limit the architecture. Unless the user explicitly limits scope, follow necessary changes into shared libraries, consumers, and adjacent subsystems so the result is coherent. Every such expansion must serve the target's design; unrelated cleanup falls outside this skill.

## Judge abstractions by the understanding they enable

An abstraction is valuable when it lets someone reason correctly with a small, dependable mental model, without keeping its implementation details in their head. Reuse and deduplication are welcome side benefits, but they neither justify an abstraction on their own nor are required for one.

Look at what callers must remember, sequence, or coordinate. If every caller rebuilds the same rules, the boundary may have left its real responsibility outside. For any proposed abstraction, name the complexity it absorbs and what its consumers no longer need to understand. Putting code behind a name is not enough. A good abstraction removes reasoning from its callers while keeping consequential choices visible.

Look for:

- **Local reasoning.** A reader can understand a responsibility without tracing the whole system.
- **Clear ownership.** Important rules, state, and lifecycle decisions each have an identifiable owner, instead of being coordinated implicitly across many places.
- **Useful contracts.** Treat internal packages as small libraries whose users are their callers. Design exported APIs deliberately, with cohesive operations, clear inputs and results, and understandable failure and lifecycle behavior. Correct use should be straightforward without reading the implementation. Internal visibility does not excuse a careless interface. Library-quality design also does not call for speculative extensibility, publishing infrastructure, or new compatibility commitments.
- **Cohesion.** Details that change for the same reason live together, and unrelated concerns stay apart.
- **Meaningful distinctions.** Separate states, options, and representations when they need different behavior or guarantees. Having arisen in different places is not reason enough. When several flags together describe one condition, consider naming that condition directly; when they describe independent facts, keep them separate instead of forcing them into one status.
- **Proportionate structure.** Each layer or extension point should solve a problem that exists today. Ask what would become harder to understand or change if it were removed, rather than whether it might be useful someday.

Fewer lines or layers do not automatically make code simpler, and more abstractions do not automatically make the architecture better. Use comments to explain reasoning that is genuinely non-obvious; intricacy that could have been avoided should be removed instead of explained.

Follow the idioms of the language and repository. In a React feature, for example, check whether state transitions and effects have coherent ownership or are scattered across rendering components. Moving the same tangled hooks into another file leaves the model unchanged, and simple local UI state does not automatically need its own state-management layer. The same principles of ownership and reasoning apply to backend services, libraries, CLI tools, and infrastructure.

## Challenge behavior selectively

Intended behavior is an important starting point, and it can still be challenged when there is a concrete reason. Sometimes a small change to product or API behavior removes a lot of complexity or makes the model much clearer.

Avoid reopening every decision. For each challenge, identify the specific behavior, the complexity it causes, the proposed alternative, and what changes for users or consumers. Keep intentional behavior changes clearly separate from redesigns that preserve behavior. Never quietly give up security, correctness, or established obligations for the sake of elegance. Make consequential behavior changes only to the extent the request authorizes.

## Keep robustness proportionate

Separate the complexity that real guarantees require from the complexity the implementation introduced. Keep the normal path clear and reliable, and do not let an endless list of hypothetical failures shape the architecture.

For an unusual case, weigh its likelihood, its consequences, how recoverable it is, and how much complexity handling it would add. A clear error, an explicitly unsupported case, or a safe retry by the user can be better than seamless recovery that needs many extra states, fallbacks, and coordination paths. Some inconvenience in a rare situation can be acceptable. Silently corrupting data or reporting false success never is. Rarity alone does not justify weakening security, data integrity, or an established contract.

State any reduced guarantee openly, and never ship a known defect in the name of simplicity. Apply the same judgment to verification: protect the guarantees that matter instead of trying to enumerate every imaginable scenario.

## Apply the design and assess the result

When explaining, lead with the recommended design and the reasons that matter most, and skip the exhaustive inventory of smells. When implementing, carry the design through every affected contract and consumer, work in coherent increments, and run the applicable checks along with meaningful behavioral verification.

Finally, measure the whole against the standard of craftsmanship. Could a newcomer use each package's API and make ordinary changes without reconstructing hidden coordination? Has complexity actually been absorbed or removed, or has it only moved somewhere else? Does the design serve present needs, or an idealized framework?
