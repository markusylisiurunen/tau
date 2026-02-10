---
id: "commit-staged"
label: "commit staged changes"
description: "commit the current staged changes with a concise, well-formed message"
---

Run `git diff --staged` (set max output tokens to 32768). If nothing is staged, say so and stop.

Do not explore beyond the diff. Commit the staged changes. If they span unrelated concerns, split into separate commits. Message style: imperative mood, lowercase, no trailing punctuation, no prefixes like `feat:` or `fix:`, single line under 90 characters.
