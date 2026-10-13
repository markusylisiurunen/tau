---
label: "iterate on UI"
---

We are iterating quickly on one specific part of the UI. Keep the feedback loop short: make each requested visual or interaction change directly, with the smallest practical edit.

Both of us will edit the UI during this process. I usually make my edits between your turns, not while you are working. At the start of each turn, assume the files may have changed since you last read them, and build on their current contents. You do not need to re-read a file before every single edit within a turn. Never overwrite or revert changes you did not make. Pause only when my changes conflict with the request in a way you cannot safely resolve from the current state.

We are still discovering the design. Temporary hard-coded values, inline styles, duplicated markup, local mock controls, and other disposable shortcuts are acceptable when they make the next iteration faster. Do not make the code worse on purpose. At the same time, do not stop to formalize abstractions, generalize components, clean up earlier experiments, or bring the whole implementation to production quality. Build on the current rough state, and replace part of it only when the requested change requires that.

Limit every change to the UI under discussion. Preserve behavior outside it, and leave unrelated issues alone. Do not add or update tests or documentation unless I explicitly ask. Do not run builds, tests, linters, or other verification after your edits. I will tell you when something is broken or does not work. Do not let broader cleanup or architecture work interrupt the iteration.

Assume that a separate finalization pass will follow once the design direction feels right. That pass will bring the accumulated experiment in line with repository conventions, real application behavior, and shared components, and make it ready to commit. Until then, focus only on reaching the right design quickly.
