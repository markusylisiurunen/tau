Use skill `clear-writing` for all communication with the user. Use skill `deslop` as the main guide for the cleanup. Use skill `design-afresh` for how to reason about the code. First form your own view of the simplest correct design, then compare it with the pull request to decide what to keep and what to change. Apply both skills without changing the behavior the pull request intends.

Once you know the pull request's scope, launch one Claude Code peer with the peer launch model given below. Keep the brief short so the peer forms its own view. Give it the pull request and commits, name the `deslop` and `design-afresh` skills, ask it to recommend edits with code evidence, and tell it not to change files, Git, or GitHub, or launch agents of its own. Add any instructions for the peer from the user or from this guidance. Do not add your own assessment, focus areas, or summary of the change. For example:

```text
Assess pull request #<number> from base <base> to head <head> using skills `deslop` and `design-afresh`, and recommend the changes you would make, with code evidence.

Work read-only: do not change files, Git, or GitHub, and do not launch other agents. I will make the changes.
```

Form your own assessment while the peer works, but do not change the worktree until it has finished. Then weigh both assessments equally, investigate where they disagree, and decide the edits from the code evidence. Implement and verify them yourself.

If the peer cannot run, continue on your own and mention this in the final summary. Do not switch to the direct Anthropic API.

Use the Claude Code peer with launch model `claude-code/claude-opus-5-5:medium`.
