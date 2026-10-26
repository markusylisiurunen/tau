Use skill `code-review` for the complete code review. Follow its guidance for investigation, finding qualification, prioritization, ordering, explanation, and suggested fixes.

Decide whether to split the review into focused parts exactly as you would without the Claude Code peer described below. The peer does not count toward the limit of six focused reviewers. Its presence, availability, and findings are never reasons to launch fewer focused reviewers or to narrow their parts.

Separately, at the start of the review, launch one Claude Code peer with the peer launch model given below. The peer is an extra reviewer that works in parallel with you. It reviews the same base and head commits in full, with the same scope and standards as your own review, and adds an independent perspective. It does not replace your own full review or any focused review. No reviewer, including the peer, may change files, post or change anything on GitHub, or launch agents of its own. Reading the pull request and its discussion on GitHub is allowed.

Keep the peer's brief short so it forms its own view. Give it the pull request and commits, name the `code-review` skill, and ask for findings with evidence. Add any instructions for the peer from the user or from this guidance. Do not add your own assessment, focus areas, or summary of the change. For example:

```text
Review pull request #<number> from base <base> to head <head>. Use skill `code-review`.

Work read-only: you may read the pull request and its discussion on GitHub, but do not change files, Git, or GitHub, and do not launch other agents. Report your findings with enough evidence for me to verify them.
```

Wait for the peer before publishing, and verify its findings like any other candidates. If the peer cannot run, continue the review as planned and mention this in the top-level review body or the no-findings comment. Do not switch to the direct Anthropic API.

Use skill `clear-writing` for the review comments, the top-level review body, and all other communication with the user. Reviewers should understand each finding on the first read, so explain what goes wrong in plain words and show it with an example where that helps.

Translate each qualifying finding into a separate inline GitHub review comment using this format:

```markdown
**[P#] <plain-language consequence>**

<the complete finding explanation>

**Suggested fix:** <the recommended correction or meaningful alternatives>
```

Each inline comment must stand on its own, so a reader can understand it without the rest of the review. Include what the reader needs to understand the problem and the fix, and leave out the rest. Keep it short while still complete: use more paragraphs only when the finding needs them, and do not cut needed detail just to make the comment look compact in GitHub.

Do not include aggregate finding numbers, `Location` fields, verdicts, findings or gaps headings, or other report-level wrappers in inline comments. GitHub already supplies the location and thread identity. Do not turn a gap you could not verify into an inline finding. If such a gap matters, mention it only in the top-level review body.

Show the problem and the fix with a small concrete example whenever that is easier to understand than an abstract description. Choose whatever form makes the problem clearest to the reader. That might be a few lines of code or pseudocode, the before and after of a data shape, a case or two with real input values that trigger the problem, or a short concrete scenario described in words. Keep examples short, include only the parts that matter, and mark omitted parts clearly. Use prose for the reasons and trade-offs that an example cannot show.

Use focused review subagents with launch model `openai-codex/gpt-6-luna:high`.

Use the Claude Code peer with launch model `claude-code/claude-opus-5-5:medium`.
