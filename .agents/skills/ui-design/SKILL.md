---
name: "ui-design"
description: "Design and refine web interfaces with guidance on visual direction, layout, typography, interaction, accessibility, motion, and polish. Use when building or redesigning frontend UI, improving its appearance or behavior, or reviewing its design. Load only the topic references needed for the requested work. Trigger: balanced."
---

Use skill `clear-writing` for communication and interface copy.

Build interfaces that suit the product and make its users' work easier. A good result has an obvious primary task, a hierarchy that reads at a glance, visual choices made for this product, and interactions that respond predictably. It holds up with real content, in every state the surface can reach, and at every supported size. One flattering screenshot proves little.

## Follow the request and the workflow

The request decides whether to design, implement, critique, or discuss. The project's workflow decides how far to take the code and what to verify. Add a new dependency only when it makes the work significantly easier or better. Do not audit the whole interface during a small change.

Two workflows change how to apply this guidance:

- **Rapid iteration.** Use the design guidance to shape what the user sees, and make each change with the smallest practical edit. Hard-coded values and local shortcuts are acceptable. Skip token cleanup, shared-component work, and verification unless the user asks for them.
- **Finalization.** Keep the composition, character, and interaction ideas of the iterated result. Rebuild them with the project's tokens, components, and real behavior, and complete the states and accessibility the iteration skipped. Do not start a new redesign. Use skill `design-afresh` for how to approach this rebuild.

The topic references end with checks. Run them only when the workflow allows verification, and only for the parts of the surface the change affects.

## Understand the surface

Read the applicable project guidance. Inspect the target, neighboring screens, shared components, tokens, and real content. Look at the rendered interface when that is available and permitted. A missing design document does not make an established product a blank slate: its existing screens are the design system.

Work out what the user needs to accomplish, which information and actions matter most, and which states the surface must support. Decide whether the task preserves the current identity, extends it, or replaces it. Refinement keeps the identity. A requested redesign may change the visual language but keeps product facts, functionality, and explicit brand commitments.

Let the surface's purpose set the emphasis:

- **Working tools** such as dashboards, editors, settings, and admin screens need familiar controls, useful density, stable layout, and fast repeated actions. Users should trust each control without stopping to decode it.
- **Reading surfaces** such as documentation and articles need a calm presentation, comfortable type, clear structure, and reliable wayfinding.
- **Marketing and expressive surfaces** can use stronger composition, imagery, and motion to make their subject memorable. The content must stay credible and the next action clear.

Choose by surface. A product's settings screen is a working tool even when its landing page is expressive.

## Load the relevant guidance

Read the references that apply before making design decisions. Paths are relative to this skill. Load another topic when the work reaches it.

| Topic                         | Reference                                                                                  | Read when                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Visual direction              | [references/visual-direction.md](references/visual-direction.md)                           | Creating a screen, choosing an identity or palette, redesigning, or fixing a generic-looking result |
| Layout and type               | [references/layout-and-type.md](references/layout-and-type.md)                             | Changing composition, density, spacing, responsive structure, or typography                         |
| Interaction and accessibility | [references/interaction-and-accessibility.md](references/interaction-and-accessibility.md) | Adding or changing controls, forms, navigation, overlays, states, or input behavior                 |
| Motion                        | [references/motion.md](references/motion.md)                                               | Adding, changing, reviewing, or diagnosing animation and gestures                                   |
| Polish                        | [references/polish.md](references/polish.md)                                               | Refining surfaces, icons, alignment, theme details, or visual consistency                           |

A new interactive screen usually needs visual direction, layout and type, and interaction and accessibility. A motion-only change starts with motion. A radius correction needs only polish.

## Keep accessibility in every change

These basics apply even when the interaction reference is not loaded:

- Use semantic elements. An action is a `<button>`; navigation is a link with a real `href`. Every control has an accessible name.
- Keep keyboard access, a visible focus indicator, and a reading order that matches the visual order.
- Do not make a task depend on hover, dragging, color, or animation alone.
- Preserve browser zoom and text scaling. Respect `prefers-reduced-motion`.
- Check contrast for text and for the visible parts that identify controls and their states.
- Hide decorative images and icons from assistive technology. Give meaningful ones an equivalent text alternative.

A visual adjustment must not remove a focus ring, shrink a target until it is hard to hit, or hide content at narrow widths.

## Make the design coherent

Product requirements and deliberate project conventions settle aesthetic choices. Accessibility and task correctness are requirements. The fonts, ratios, radii, curves, and durations in the references are starting points for projects that have not decided yet. Adapt them to the content, component, and platform. A deliberate convention that differs from a reference value is not a defect.

Reuse the project's design language where it fits. When a recurring concept needs a new token or variant, add it where the shared concept lives. Keep a one-off composition local. Avoid a second set of nearly identical values hidden in page-level overrides.

For new work, settle the hierarchy and composition before tuning surface details. Then work in this order: tasks that are blocked or inaccessible, missing states, structure and type, and finally surfaces and motion. A perfect shadow on a screen with a broken empty state is wasted effort.

For a critique, first describe the experience the surface is trying to create. Order findings by the same priority. Each finding names its location, what goes wrong for the user, and a correction. Taste alone is not a finding. For example:

> **Primary action loses to a secondary one** (`BillingPage.tsx:84`). "Export CSV" uses the filled accent style and sits first, while "Upgrade plan", the reason most people open this page, is a text link below the table. Swap the treatments and move "Upgrade plan" into the header.

## Assess the result

When verification is allowed, inspect the affected path at representative narrow and wide sizes, with realistic content and the relevant states. Use the keyboard, and exercise any pointer behavior that changed. Watch motion at normal speed, interrupt it, and check reduced motion; a screenshot shows neither.

Then look at the whole. Is the primary task obvious? Does the result look like part of this product? Do repeated elements follow the same rules? Batch corrections into one pass instead of cycling through tiny edits. Stop when the requested result holds and the applicable checks pass.

Report briefly. Separate what you saw in a browser or on a device from what you inferred from source, and name important gaps. Never claim accessibility compliance or smooth performance from appearance alone.
