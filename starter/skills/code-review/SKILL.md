---
name: code-review
description: Conduct rigorous code review for git changes and return prioritized, actionable findings in a strict verdict/findings format. Trigger: explicit.
---

## Select review scope and primary diff command

Infer scope from the user request. Wrapper prompts may include `What to review: ...`, but do not require that exact line.

Default to uncommitted changes when scope is not explicitly specified.

Use this mapping:

- Uncommitted or current changes -> `git diff HEAD`
- Current branch -> `git diff main...HEAD`
- Most recent commit -> `git show HEAD`

If the request contains conflicting scope signals, ask a clarifying question first.

For every diff/show command you run (`git diff ...`, `git show ...`), set bash `maxOutputTokens` to `32768`.

## Gather context

Read the primary diff output carefully before surfacing findings.

When you need more context (surrounding code, related functions, type definitions), use focused follow-up reads: `cat`, `rg`, `sed -n '<start>,<end>p'`, or similar. Fetch only what you need to evaluate the change. If referenced code is inaccessible, call out that gap because missing expected changes can indicate real issues.

## What to flag

Flag an issue only when it meets all criteria below:

1. **Impact**: It meaningfully affects correctness, performance, security, or maintainability.
2. **Cleanliness**: It is leftover debug code (`console.log`, print statements), commented-out code, or exposed secrets.
3. **Actionable**: The fix is discrete, not a general complaint.
4. **New**: The issue was introduced in the reviewed change, not pre-existing (unless the change made it worse).
5. **Provable**: You can point to specific code. No speculation.
6. **No assumptions**: The issue does not rely on unstated assumptions about intent.
7. **Proportionate**: The fix does not demand excessive rigor for the context.

Report all qualifying findings. Do not stop at the first one. If none qualify, say so.

## Priority levels

Prefix each finding title with one priority:

- **[P0]**: Critical. Drop everything. (for example, crashes, security holes, data loss)
- **[P1]**: Urgent. Fix this cycle. (for example, wrong logic, major regression, debug code left in)
- **[P2]**: Normal. Fix soon. (for example, minor bugs, maintainability issues)
- **[P3]**: Low. Nice to have. (for example, style and naming nits)

## How to comment

1. **Clear and brief**: One paragraph max. No filler. Matter-of-fact tone.
2. **Instant grasp**: Make the issue obvious at a glance.
3. **Context**: Explain why it matters and when it breaks.
4. **Snippets**: Use short code blocks when needed.
5. **Line ranges**: Keep ranges tight.
6. **Suggestions**: If providing replacement code:
   - Use a markdown code block.
   - Preserve exact leading whitespace.
   - Do not change outer indentation unless that is the fix.

## Output format

1. **Verdict**: `Verdict: [Correct|Incorrect]` plus a one to three sentence summary.
   - "Correct" means no blocking issues (P0/P1).
   - "Incorrect" means blocking bugs or broken functionality.

2. **Findings**: For each finding include:
   - **Title**: `[P#] <Imperative title>`
   - **Location**: `<file-path>:<line-range>`
   - **Description**: One paragraph.
   - **Suggestion**: Optional replacement code block.

3. **Unverified assumptions**: List only assumptions that are critical to correctness and cannot be inferred from context.
