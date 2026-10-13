---
description: "finalize UI"
disable-model-invocation: true
---

Make the current uncommitted UI changes ready to commit.

The UI was developed through rapid visual iteration, by me alone or by us together. It probably looks close to the desired result, but the code still reflects the exploratory path that led there. Use the current result to understand the intended direction and feel, then turn it into code that belongs in the repository.

Read the applicable `AGENTS.md` files, inspect the complete set of current changes, and follow the changed behavior into the relevant surrounding code. Make sure you understand the intended experience before you edit anything. Repository guidance is authoritative for ownership, component boundaries, styling, UI-state coverage, testing, documentation, and verification.

Treat the current UI as strong evidence of the product intent, but not as a pixel-perfect specification. Preserve the overall composition, visual character, density, vocabulary, and interaction ideas that made the iteration work. Adjust spacing, sizing, alignment, and layout details where the current values are arbitrary or inconsistent, or where they compensate for the wrong structure. The finished UI should feel like the same design, rebuilt with the application’s real system. Do not quietly restore the old UI just because it was more established, and do not turn finalization into a new product or visual redesign either.

Use skill `design-afresh` on the implementation behind the iterated UI. Fast, step-by-step iteration tends to lock in whatever structure came first. Step back now and ask what implementation you would build if you started from the current design, and do not settle for a weaker structure just because the iteration happened to produce it. The design-afresh pass applies only to the code and leaves the intended UI described above unchanged.

Rapid iteration often leaves behind mock controls, inert actions, inline styles, arbitrary values, duplicated markup, page-local versions of reusable concepts, accidental changes to shared defaults, stale names, weak state handling, or code placed at the first convenient layer. Find these shortcuts and replace each one with the simplest canonical implementation that keeps the intended direction. Use existing patterns where they fit. When the iteration has produced a reusable variant, token, or composition, add it at its correct owner instead of hiding it in a screen-specific override.

Next, check the experience end to end. Every visible control should perform its real action. Data, loading, error, empty, disabled, and retry states should stay consistent with each other. Routes, query state, API-backed filtering or search, accessibility semantics, keyboard behavior, focus treatment, and interactive nesting should match established application behavior. Names should stay consistent across route-level files, components, props, styles, state, and supporting fixtures.

Use judgment about abstraction. Consolidate repetition when it represents one stable concept. Keep deliberately experimental or page-owned composition local when a shared abstraction would only make the code harder to change. Prefer direct, readable code over both prototype hacks and premature frameworks.

Limit the work to the iterated UI and the integration changes needed to make it real. Do not commit. Before you finish, inspect the final changes for accidental scope, temporary artifacts, dead code, naming drift, and formatting churn. Then run the formatter and checks that the repository prescribes for every affected area, and fix all failures.
