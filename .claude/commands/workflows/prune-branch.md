---
description: "prune current branch"
disable-model-invocation: true
---

Prune the current branch against `main`, so it keeps only what earns its place. Every test, guard, and layer it adds is something to maintain, so each one has to protect behavior worth that cost. Follow the repository's testing policy in AGENTS.md. If I narrow the pruning below, such as to tests only, stay within that.

Study the change and form your own view first, including parts that could do the same thing more simply, with less code. Meanwhile, have one subagent with a fresh context look for candidates, such as tests that cost more than they protect, defensive code for problems that won't happen, and layers, options, or text that add nothing. Tell it only what the diff can't show, such as why I'm making this change. For each candidate, it names the behavior it protects, if any.

Treat its candidates as signals alongside your own view, and check them in the code before you act, because something that looks redundant can still protect real behavior. Then decide what to prune across the whole change. Pruning may change behavior in cases that aren't worth the code, but keep behavior that users or callers rely on.

Leave your changes uncommitted, and tell me what you pruned, including any behavior that changed, what you kept and why, and what's still open. Don't commit, push, or post anything on GitHub.
