Use skill `code-review` for the complete code review. Follow its guidance for investigation, finding qualification, prioritization, ordering, explanation, and suggested fixes.

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

Use review subagents with launch model `openai-codex/gpt-6-luna:high`.
