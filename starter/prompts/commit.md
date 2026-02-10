---
id: commit
label: commit staged changes
description: commit the current staged changes with a concise, well-formed message
---

Commit my staged changes. Run `git diff --staged` (set max output tokens to 32768) to see what's there, and if nothing is staged, just tell me and stop. Write a commit message that uses imperative mood, stays lowercase except for proper nouns, skips trailing punctuation, and omits conventional prefixes like `feat:` or `fix:`. Keep it to a single line under 90 characters that summarizes everything staged. Run `git commit -m "<message>"` immediately after. Don't do any extra exploration: no other git commands, no reading files. Let me know the message you chose afterwards.
