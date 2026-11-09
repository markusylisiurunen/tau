Run the review with the `review` workflow from skill `tau-workflows`. This guidance authorizes its delegation. The workflow plans the review, runs the reviewers, and chooses the findings worth raising with a final agent. Do not launch reviewers of your own, and do not perform a separate full review.

Pass these inputs:

- `base`: the merge base of the pull request's target branch and its head, as a full commit ID.
- `head`: the pull request's head commit, as a full commit ID. It must match the checked-out `HEAD`.
- `context`: where the intent behind the change is recorded, usually the linked issue, such as `Read issue #120 for context.` Use the actual numbers, and add any requirements from the triggering comment.

Set `depth` only when the user asks for one.

The workflow's output is a log followed by the final result, which lists any warnings, the qualifying findings, and the dropped candidates. Publish the qualifying findings as the review, following the built-in review instructions and the format below. The workflow has already assessed them, so do not check them again, drop them, or add findings of your own, and do not publish dropped candidates. The output is normally enough. Read the files in the workflow's run folder only when it is not.

Start the top-level review body with a short overview in natural sentences: how many issues the review found, its depth, the number of focused reviews when there were any, the total cost from the log, and anything that failed. Leave the issues themselves to the inline comments. So that the wording varies between reviews, run `shuf -i 1-8 -n 2` and let the two examples whose numbers it prints influence your style the most. Treat them as a starting point, not a template, and word your overview in your own way:

1. Found 2 issues in a deep review with 3 focused reviews. The review cost $2.14.
2. Found no issues in a light review, which cost $0.31.
3. A standard review found 3 issues and cost $1.02.
4. Found 2 issues in a deep review with 2 focused reviews. One focused reviewer failed, so the review is incomplete. It cost $1.63.
5. The light review found nothing to raise. It cost $0.28.
6. No issues came up in a standard review, which cost $0.74.
7. A deep review with 2 focused reviews found 1 issue, at a cost of $1.91.
8. Found 2 issues in a standard review. The second general reviewer failed, so the review is incomplete. It cost $0.66.

If the result lists warnings, mention them, including which reviewer failed and that its coverage is missing. If the workflow fails or cannot run, say in the top-level response that the review did not complete and why, and what it cost so far, which is the last total in the log. Do not describe the pull request as reviewed or free of findings in that case.

Use skill `clear-writing` for the review comments, the top-level review body, and all other communication with the user. Reviewers should understand each finding on the first read, so explain what goes wrong in plain words and show it with an example where that helps.

Translate each qualifying finding into a separate inline GitHub review comment using this format:

```markdown
**[P#] <plain-language consequence>**

<the complete finding explanation>

**Suggested fix:** <the recommended correction or meaningful alternatives>
```

Each inline comment must stand on its own, so a reader can understand it without the rest of the review. Include what the reader needs to understand the problem and the fix, and leave out the rest. Keep it short while still complete: use more paragraphs only when the finding needs them, and do not cut needed detail just to make the comment look compact in GitHub.

Do not include aggregate finding numbers, `Location` lines, headings, or other result-level wrappers in inline comments. GitHub already supplies the location and thread identity.

Show the problem and the fix with a small concrete example whenever that is easier to understand than an abstract description. Choose whatever form makes the problem clearest to the reader. That might be a few lines of code or pseudocode, the before and after of a data shape, a case or two with real input values that trigger the problem, or a short concrete scenario described in words. Keep examples short, include only the parts that matter, and mark omitted parts clearly. Use prose for the reasons and trade-offs that an example cannot show.
