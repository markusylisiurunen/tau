---
name: "code-review"
description: "Conduct rigorous code review and return prioritized, actionable findings that explain each issue clearly without requiring a separate walkthrough. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

Use skill `clear-writing` for all communication with the user.

Examine the proposed change and find the issues worth fixing. Investigate thoroughly, and explain each finding well enough that the reader can understand the problem and act on it without a separate walkthrough.

A request to review does not by itself permit you to edit files or publish a GitHub review. Follow the scope, format, and workflow that the request asks for. Where the request leaves them open, the guidance below supplies the defaults.

## Establish the scope

Infer the target from the request. If the request names no target, review the current uncommitted changes. If the signals about scope conflict, ask one focused question before you start.

- **Current changes:** inspect staged and unstaged changes against `HEAD`, plus relevant untracked files. Use `git status --short` to find files that a diff alone would miss.
- **Current branch:** review the complete branch change against the requested base. If no base is given, work out the intended target from the repository or PR context. Do not assume `main`.
- **Pull request:** establish its actual target branch and current remote head. Review the net change from the merge base. The latest commit alone is not enough, and a local checkout may be stale.
- **Most recent commit:** inspect `git show HEAD`.
- **Named commit, range, patch, or file set:** review exactly that target.

Read the applicable repository guidance. When you obtain the code to review, preserve any uncommitted or unrelated work. Record which revision you inspected. If the target changes during the review, inspect the affected net change before you present conclusions.

By default, cover the full change and its meaningful risks, including correctness, security, performance, and maintainability. If the request asks for a narrower focus, follow it. Read beyond the target for context, but do not let that reading grow into an unrelated review of the whole repository.

## Understand the change independently

Start by listing the changed files and the role of each. Then inspect the change in whatever grouping makes it easiest to understand. Before you finish, account for every substantive change. Generated or mechanical files may need only a check that they are consistent with their sources, instead of a line-by-line reading.

Form your first understanding from the code, before you adopt the framing of the author or of earlier reviewers. Read descriptions and discussions when they help establish intent, requirements, or constraints, and check what they claim against the implementation. Neither a PR description nor an existing review proves what the code does.

Read surrounding code, trace callers, and inspect contracts and tests. Make sure you understand the behavior before and after the change, how the affected parts interact, and what the tests actually prove. Then look for incomplete updates to consumers, schemas, configuration, generated output, documentation, and anything an AI model sees, such as prompts or tool definitions.

Investigate suspicious behavior before reporting it. Check relevant external documentation when a conclusion depends on an API or service contract. Use focused checks or reproductions when they help settle a question, and follow the repository's rules for running code. A reproduction is useful, but you do not need one when the code and established contracts already show the problem. Never claim verification you did not perform.

## Look for consequential problems

Use these areas to guide your investigation where they apply. They are not a quota of findings to fill:

- **Correctness:** wrong results, missing cases, races, broken state transitions, resource leaks, and error handling that loses or hides failures.
- **Security:** exposed secrets, injection, missing input validation, broken authorization, and failures of isolation or trust boundaries.
- **Performance:** material regressions, avoidable expensive work on important paths, and behavior that will not handle the expected workload.
- **Maintainability:** fragile coupling, duplicated rules that can drift, misleading contracts, and boundaries that force callers to reconstruct hidden implementation details.
- **Incomplete work:** debugging remnants, dead paths, accidental artifacts, and required updates missing from other parts of the system.
- **Compatibility:** effects on existing data, callers, configuration, formats, and protocols. First establish which guarantees the project actually makes. Then check that supported data stays accessible and supported consumers still work, or that an intentional change comes with an adequate migration or transition. Do not invent compatibility requirements for behavior that was never supported.

Also step back and judge how the change fits the design of the system as a whole. Ask whether it looks like it belongs there, or whether it was bolted on wherever it was easiest to attach. Signs of a bolted-on change include a new special case or flag that callers must coordinate, a rule copied into several places instead of owned by one, state without a clear owner, a boundary that callers have to work around, and operations that behave differently from the ones they correspond to. To judge the fit, picture what you would build today for the same need, given what the system already has to do. A cleaner design that would require a substantial restructuring can still be the right recommendation, and a small diff is not a reason to accept a weaker fit.

A design problem qualifies as a finding when you can name its concrete cost: what callers must now remember or coordinate, which rule can drift, or which likely change becomes harder. A different design that is only a matter of taste does not qualify. Limit design findings to problems the change introduces or makes worse, and do not turn the review into a redesign or cleanup of unrelated code.

## Decide what qualifies as a finding

Report a finding only when it is:

1. **Actionable:** there is a concrete correction or decision the author can make.
2. **New:** the change introduces the issue or materially worsens an existing problem.
3. **Supported by evidence:** the reviewed code and established facts support the problem and its consequence. It does not depend on speculation or an unstated assumption.
4. **Proportionate:** the concern and proposed response fit the actual context and risk.

Weigh likelihood, consequence, and the cost of the fix together. Do not report a failure that is technically possible if its conditions are unrealistic and the fix would cost more than the issue is worth. Rare problems can still qualify when the consequence is severe, the condition is externally controllable, or the correction is simple and low-risk.

Report every qualifying finding. When several symptoms share one root cause and one explanation and correction cover them all, combine them into one finding and list the affected locations. Keep issues that can be fixed independently separate. If no findings qualify, say so directly. Saying so does not by itself claim that the change is safe or fully verified.

## Set priorities

Prefix each finding title with its practical priority:

- **[P0]**: Critical and release-blocking. Immediate action is required.
- **[P1]**: High impact. The change should not proceed without a fix.
- **[P2]**: Normal priority. The issue should be corrected, but does not demand emergency action.
- **[P3]**: Low impact. The improvement is worthwhile but not urgent.

Base the priority on the demonstrated consequence. How complicated the implementation looks does not matter.

## Explain each finding

Follow `clear-writing` for voice, wording, and examples. Assume the reader knows the project but does not have this subsystem or this change in mind, so each finding must stand on its own.

Use a title that states what goes wrong in plain words. Then explain the intended behavior where needed, the condition that breaks it, the consequence, and the recommended correction. Define project terms the reader may not know. State the harm directly, so the reader does not have to infer it from a description of how the code works.

Keep each finding short while still complete. Use more paragraphs when the explanation needs them, and do not cut necessary context just to make the finding look compact.

Use a small example when it makes the problem or the fix easier to follow. Choose the example that makes the issue easiest to understand: a few lines of code, a before-and-after data shape, actual input values, or a short sequence of events. Show the proposed fix too when that makes its effect clearer.

For instance, instead of only saying that a retry is not idempotent, show the sequence: the first request saves the payment, its response is lost, and retrying with a new request ID saves a second payment. Then explain which ID must remain stable and why.

Recommend one fix when the evidence supports a clear correction. Present alternatives only when they reflect a real choice of product, architecture, compatibility, or implementation. Explain the practical consequences of each, and recommend one when you can. Do not invent cosmetic alternatives.

Keep location ranges focused on the relevant code. In replacement snippets, preserve the original leading whitespace unless changing indentation is part of the fix.

## Report findings and remaining uncertainty

Order findings by priority, and number them so the user can refer to each one in later discussion. Use the format below unless the user or the active workflow asks for another, such as inline GitHub comments. You may adapt the presentation, but keep the evidence, the consequence, and the suggested fix.

```markdown
## Findings

### 1. [P#] <plain-language consequence>

**Location:** `<file-path>:<line-range>`

<The context, condition, and consequence, with a small example where useful.>

**Suggested fix:** <Recommended correction, or meaningful alternatives and a recommendation.>
```

Repeat for each finding, or state "No findings." when none qualify.

Add a `## Gaps` section only for unresolved uncertainty that matters to the review. State what you could not establish and how that limits the conclusion. Before you list a gap, look for the answer in the code or in documentation you can access. Keep unverified risks separate from confirmed findings, and omit the section when there are no material gaps.
