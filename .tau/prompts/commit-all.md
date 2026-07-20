---
id: "commit-all"
label: "commit all changes"
description: "stage and commit all current changes with a concise, well-formed message"
---

Run `git status --short` and `git diff HEAD` (set max output tokens to 32768). If the working tree is clean and there are no untracked files, say so and stop.

Do not explore beyond the diff. Stage and commit all changes. If they span unrelated concerns, split into separate commits. Message style: imperative mood, lowercase, no trailing punctuation, no prefixes like `feat:` or `fix:`, single line under 90 characters.
