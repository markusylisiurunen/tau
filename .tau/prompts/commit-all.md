---
label: "commit all changes"
---

Run `git status --short` and `git diff HEAD` (set max output tokens to 32768). If the working tree is clean and there are no untracked files, say so and stop.

Do not explore beyond the diff. Stage and commit all changes. If they span unrelated concerns, split into separate commits. Follow skill `github-workflow` for commit formatting.
