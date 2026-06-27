---
id: "deslop-branch"
label: "clean up current branch"
description: "clean up, canonicalize, and tighten the current branch"
---

Use @@skill:deslop. Think hard and be thorough. Your target is the current branch. Enumerate its changes with `git diff main...HEAD` (set `maxOutputTokens: 32768` for large diffs). Treat that diff as the entry surface; follow into surrounding code as the skill directs.
