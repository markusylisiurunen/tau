---
name: "code-review"
description: "Conduct rigorous code review for git changes and return prioritized, actionable findings in a strict verdict/findings format. Trigger: explicit."
---

## Goal

Examine proposed changes made by another engineer. Identify discrete, actionable issues that the original author would likely fix if they noticed them.

Think hard and be thorough. A sloppy review is worse than no review.

## Review mode and focus

By default, run a comprehensive, balanced PR-style review. Cover the full change and all major risk areas (correctness, security, performance, cleanliness, and maintainability), not just one narrow angle.

If you were given a specific review focus, angle, or additional instructions (for example, "focus on performance" or "look only for security issues"), follow that requested focus instead of the default broad pass.

## Select review scope

Infer scope from the user request. Wrapper prompts may include `What to review: ...`, but do not require that exact line.

Default to uncommitted changes when scope is not explicitly specified.

Use this mapping:

- Uncommitted or current changes -> `git status --short` and `git diff HEAD`
- Current branch -> `git diff main...HEAD`
- Most recent commit -> `git show HEAD`

If the request contains conflicting scope signals, ask a clarifying question first.

For every diff/show command, set bash `maxOutputTokens` to `32768`.

## Understand the change

Start with the diff, but do not stop there. Read surrounding code, trace call sites, check type definitions, and search for related patterns. Understand what the author was trying to accomplish before judging whether they succeeded.

Examine every changed file, not just the obvious ones. Trace how changes interact across files. Consider edge cases, error paths, and implicit assumptions. When changes in one file imply corresponding changes elsewhere and those are absent, treat that as a red flag. Do not guess when reading more code would give you the answer. If a change looks suspicious, verify before flagging.

## What to look for

Actively hunt for issues across these categories:

- **Correctness**: Logic errors, broken edge cases, off-by-one mistakes, race conditions, missing error handling.
- **Security**: Injection vulnerabilities, exposed secrets, missing input validation, broken access controls.
- **Performance**: Unnecessary allocations in hot paths, O(n²) where O(n) is straightforward, missing indexes.
- **Cleanliness**: Leftover debug code (`console.log`, print statements), commented-out code, dead imports.
- **Maintainability**: Fragile coupling, misleading names, duplicated logic that will drift.

## When to flag

Report a finding only when it is:

1. **Actionable**: The fix is discrete, not a general complaint.
2. **New**: Introduced in the reviewed change, not pre-existing (unless the change made it worse).
3. **Provable**: You can point to specific code and explain why it breaks. No speculation, no unstated assumptions about the codebase or author intent.
4. **Proportionate**: The fix does not demand excessive rigor for the context.

Report all qualifying findings, not just the first one. If none qualify, say so.

## Priority levels

Prefix each finding title with one priority:

- **[P0]**: Critical. Drop everything. (for example, crashes, security holes, data loss)
- **[P1]**: Urgent. Fix this cycle. (for example, wrong logic, major perf regression, debug code left in)
- **[P2]**: Normal. Fix soon. (for example, minor bugs, maintainability issues, clear typos)
- **[P3]**: Low. Nice to have. (for example, style, naming nits)

## How to comment

Write so the author understands at a glance. One paragraph max per finding. No filler ("Great job", "Thanks"). Explain why the issue matters and when it breaks. Mention specific scenarios or inputs if relevant.

Use short code blocks for snippets. Keep line ranges tight to pinpoint the problem. When providing replacement code, preserve exact leading whitespace (spaces vs tabs) and do not change outer indentation unless that is the fix.

## Output format

Use "Correct" when there are no blocking issues (P0/P1). Use "Incorrect" when there are blocking bugs or broken functionality.

Gaps are things that matter for correctness but require information from outside the codebase to verify: external API contracts, deployment configuration, third-party service behavior, upstream schema compatibility. If the answer lives somewhere in the code, it is not a gap. Read the code and resolve it. Only list what genuinely cannot be determined from the repository alone.

```
Verdict: [Correct|Incorrect]

<one to three sentence summary>

## Findings

### [P#] <imperative title>

**Location**: `<file-path>:<line-range>`

<one to two paragraph description>

<optional suggestion code block(s)>

(...repeat for each finding, or "No findings." if none qualify)

## Gaps

- <gap, or "None.">
```
