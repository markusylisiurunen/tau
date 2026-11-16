---
description: "rewrite text in current branch"
disable-model-invocation: true
---

Rewrite the text that the current branch changes against `main`, and text elsewhere in the repository that the branch should have changed but didn't, so it serves its readers. Text means anything written for a reader, such as docs, agent instructions, prompts and tool descriptions in code, and interface copy. If I name a narrower target below, rewrite only that.

Start from what each text is for and who reads it, then from its source material, such as the code it describes. Follow the repository's writing guidance in AGENTS.md, and use skill `clear-writing`, including its part on writing for AI models when the reader is a model. You may change what a text asks its reader to do when that serves its purpose better, but keep the facts and the rules that protect something. This is a pass over the text, and you can change code where the text needs it.

When you have a draft, have one subagent with a fresh context read it as its intended reader and compare it with the original. It reports what doesn't work for that reader and every fact or rule that changed or disappeared. Then revise the draft.

Leave your changes uncommitted, and tell me briefly what changed, and point out where the text now says or asks for something different. Don't commit, push, or post anything on GitHub.
