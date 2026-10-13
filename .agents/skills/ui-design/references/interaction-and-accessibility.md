# Interaction and accessibility

Make every task work with the input methods and assistive technology the product supports. Visual polish cannot make up for an action that people cannot find or complete.

## Use the platform's semantics

Use a `<button>` for an action and a link with a real destination for navigation. A `<div>` with a click handler has no role, no keyboard access, and no focus, and adding them back by hand is error-prone. Native controls already handle the keyboard, so do not add duplicate key handlers to them. For custom menus, tabs, comboboxes, and dialogs, use the project's established accessible primitives. Roles, keyboard behavior, and focus handling must all agree with the pattern the widget claims to be.

Give every control an accessible name, preferably a visible label associated with it. An icon-only button needs a name that describes its action (`aria-label="Delete draft"`, not "trash"). A tooltip can explain an icon but must not be its only name. Hide decorative icons with `aria-hidden="true"`. Meaningful images need alt text that conveys their purpose; decorative images get `alt=""`.

Use headings and landmarks that reflect the page structure, and provide a skip link past repeated navigation. Use real table markup for tabular data. When audio or video is part of the task, provide captions, a transcript, or a description as appropriate.

## Keep focus and input predictable

Every interactive element needs a visible focus indicator. Never remove the outline without a replacement that is at least as visible. `:focus-visible` shows the indicator for keyboard use without adding a ring after every mouse click. Use `scroll-margin` or `scroll-padding` so focused elements do not land under sticky headers or fixed footers.

Keep tab order logical and avoid positive `tabindex`. When content updates, keep focus where it was, or move it somewhere sensible if the focused element disappeared. Composite widgets follow the keyboard pattern for their role: arrow keys move within tabs, menus, and listboxes, and Tab moves past them.

A modal dialog moves focus inside, makes the background inert, closes with Escape, and returns focus to its trigger, or to another logical place if the trigger is gone. The native `<dialog>` element opened with `showModal()` handles most of this. A non-modal popover should not trap focus. The `popover` attribute gives light dismissal and correct layering without a library.

Before reaching for a modal, check whether the task needs to interrupt the page at all. Inline editing, an expanding row, or a side panel often keep context that a modal hides. Use a modal for decisions that must block, such as confirming a destructive action, or for focused tasks that would be confusing alongside the page.

Make pointer targets forgiving. About 44×44 CSS pixels is a good default for touch, even when the visible icon is smaller; extend the hit area with padding or a pseudo-element. WCAG 2.2 AA requires 24×24 CSS pixels or enough spacing around smaller targets, with some exceptions. Meeting that minimum does not make a crowded toolbar comfortable. Do not let hit areas overlap.

Limit decorative hover effects to devices that can hover. Any action revealed on hover must also be reachable by focus and on touch. Do not block zoom or override native scrolling. Dragging, swiping, and other path-based gestures need a single-pointer and keyboard alternative unless the gesture is the point of the task, such as drawing a signature.

## Make forms understandable and recoverable

Every field needs a persistent label. A placeholder can show an example format but disappears as soon as the user types. Set the right `type`, `inputmode`, and `autocomplete` values; `autocomplete="one-time-code"` and `"new-password"` noticeably help mobile users and password managers. Do not block paste or disable autocomplete without a specific reason.

Make each checkbox or radio share a click target with its label. State requirements, format constraints, and consequences before submission. Do not use color alone to mark an error.

Keep the submit button enabled so people can submit and find out what to fix, unless the product has a clear reason to disable it. If a button must stay disabled, show nearby why it is disabled. While a request is pending, prevent duplicate submission and show that work is happening. Keep the entered values after a recoverable failure.

Put each field error next to its field and connect it with `aria-describedby`, and mark the field with `aria-invalid="true"`. After a failed submission, move focus to an error summary or to the first invalid field, following the project's convention. Announce asynchronous results without interrupting typing: use a polite live region or `role="status"` for ordinary updates, and keep `role="alert"` for urgent ones. Validate on blur or submit; flagging an email as invalid after its first character only adds noise.

Name actions by their result: "Save changes", "Create project", "Send invitation". Use the same verb through the flow, so "Publish" leads to "Published". Error messages say what went wrong and what to do next, without exposing sensitive system details and without replacing a useful explanation with a generic apology.

## Design every state

List the states the feature can actually reach: initial, loading, empty, partial, success, error, offline, and permission-limited. Each one should tell the user what is happening and what they can do. An empty state for a new account should help them create the first item; an empty result from filters should offer to clear the filters. An error keeps the useful context on screen and offers a retry where one can work.

Match loading feedback to the task. A skeleton preserves the shape of content that is about to arrive; a small spinner suits a button. For very fast responses, delay showing the spinner or skeleton briefly to avoid a distracting flash, but show it if the request remains pending. Acknowledge the action immediately and prevent duplicate submission throughout. Never delay the result to keep a loading indicator visible. During background refreshes, keep showing the existing data when it is still valid. Show success only once the operation has the guarantee the product promises; an optimistic update needs a visible rollback when the request fails.

For consequential destructive actions, require confirmation or offer an undo that really restores the data. Name the object and the consequence ("Delete 'Q3 report' and its 12 comments?"). Low-risk, reversible actions do not need a modal.

Put filters, pagination, tabs, and selections in the URL when people need to bookmark, share, or come back to them. Keep transient state, such as an open menu, local. Never put sensitive values in a URL. Keep normal link behavior, including opening in a new tab, and the browser's back button. Warn before navigation would discard unsaved work.

## Check contrast and alternatives

WCAG AA requires 4.5:1 for normal text and 3:1 for large text, meaning at least 24px, or about 18.7px when bold. Visible parts that identify controls and states, such as input borders, focus indicators, and selected markers, need 3:1 against adjacent colors. The criteria exempt inactive controls, but a disabled control that nobody can read still hides information.

Measure the actual rendered colors, including opacity and text over images, in every supported theme and state. Do not rely on color alone for selection, errors, or chart categories; add a label, icon, pattern, or shape.

In forced-colors mode (Windows high contrast), backgrounds and shadows are replaced with system colors, so a control drawn only with a shadow or background disappears. Use real borders or outlines, even transparent ones, so the system can paint an edge.

## Check the behavior

Complete the affected path with only the keyboard. Inspect names, roles, states, focus movement, and announcements with the available accessibility tools. Exercise changed gestures with touch or simulated pointer input, including cancelling midway and scrolling the page across the control. Resizing a desktop viewport tests layout; it does not test touch.

Try the relevant states with slow and failed responses and realistic content. In the report, keep automated checks, source review, browser testing, screen-reader testing, and physical-device testing separate. None of them alone proves full accessibility compliance.
