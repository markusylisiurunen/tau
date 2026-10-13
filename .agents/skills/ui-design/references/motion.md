# Motion

Decide whether motion helps before choosing a duration or a library. Motion can confirm an action, show what changed, keep track of where something came from, or give an expressive surface a memorable moment. Leave it out when it delays the user or adds no meaning.

## Decide by frequency and purpose

How often people see an animation matters more than how good it looks the first time. An effect that is pleasant once becomes friction on the hundredth repetition.

| Frequency  | Examples                                                | Motion                                     |
| ---------- | ------------------------------------------------------- | ------------------------------------------ |
| Constant   | Typing, list navigation, command palette, tab switching | None, or a color change of 150ms or less   |
| Frequent   | Hover feedback, toggles, menus                          | Short and quiet                            |
| Occasional | Dialogs, drawers, toasts                                | Enough to show where the element came from |
| Rare       | Onboarding, a first success, a marketing demonstration  | Room for something more expressive         |

A command palette that people open dozens of times a day should appear instantly. The same state change should be equally quick and understandable whether it was triggered by keyboard, mouse, or touch.

On expressive surfaces, one orchestrated moment, such as a single page-load sequence or one reveal, lands better than effects scattered everywhere. Do not animate every section on scroll or stagger every list by default. In working tools, motion should show a change of state; tools should load straight into the task without a page-load sequence.

Content must be visible in its default state. If an entrance effect depends on a script, a script failure must not leave the page blank. Never make functionality wait for decorative motion to finish.

## Choose the simplest implementation

Use CSS transitions for interactive state changes. A transition retargets from wherever it currently is when the state flips mid-way; a keyframe animation restarts from its first frame, which makes rapid toggling jump.

```css
/* Reverses smoothly if the menu closes while still opening */
.menu {
  opacity: 0;
  transform: translateY(-4px);
  transition:
    opacity 150ms ease-out,
    transform 150ms ease-out;
}
.menu[data-open] {
  opacity: 1;
  transform: none;
}
```

These styles only control appearance. Use the widget's semantics and focus handling to keep a closed menu out of the tab order and prevent invisible items from receiving clicks.

Use keyframes for sequences that run once, and handle cancellation if the sequence becomes interactive. The Web Animations API (`element.animate()`) gives programmatic control without a dependency. Use the project's motion library when springs, exit animations, shared layout transitions, or gestures justify it. Do not add a library only for a fade or an icon swap.

`@starting-style` animates an element's first appearance in CSS, and `transition-behavior: allow-discrete` lets `display` and `overlay` transition so a popover or dialog can animate out. Check browser support for these and for View Transitions before relying on them, and make sure the state change still works without the transition.

Name the properties that change, and avoid `transition: all`, which animates things you did not intend, such as colors during a theme switch. Prefer `transform` and `opacity` when they express the change. They usually avoid layout and paint work, though whether they run off the main thread depends on the browser, the animation driver, and the element.

Do not fake a size change with `scale` when it would distort text or leave the layout wrong. An accordion can animate `grid-template-rows` from `0fr` to `1fr`, or use a measured height. Keep the animated region small, and profile if it stutters. Blur, masks, `clip-path`, and shadows are legitimate tools, but their cost grows with area and varies by device. Large blurs are especially expensive in Safari.

## Tune timing and easing

Use the project's motion tokens. Where none exist, these are reasonable starting ranges:

| Change                               | Starting duration |
| ------------------------------------ | ----------------- |
| Press feedback                       | 100–160ms         |
| Tooltip or small popover             | 125–200ms         |
| Menu, select, routine state change   | 150–250ms         |
| Dialog, drawer, larger layout change | 200–400ms         |

Most product UI motion stays under about 300ms. Longer motion can suit an explanatory sequence on a marketing page, but it needs a reason and must not block the task. Exits can be shorter than entrances. Keep the exit direction meaningful: a drawer closes back toward its edge, while a disappearing label can simply fade.

Use ease-out for elements entering or responding to input, so the movement starts immediately. Avoid ease-in for these; it delays the start, which is exactly when the user is watching. Use ease-in-out for elements moving from one place to another on screen, and linear only for constant motion such as a progress bar or marquee. The built-in `ease-out` is weak, and a stronger curve such as `cubic-bezier(0.23, 1, 0.32, 1)` makes entrances feel more immediate. Use one curve family consistently instead of choosing a new one per component.

Timing can be asymmetric. A hold-to-confirm action fills slowly and linearly, because the user is deciding. Releasing early snaps back quickly, because the system is responding.

Keep springs controlled in product UI. Bounce can suit a playful gesture or a drag release, but rarely belongs in a settings form. Check how any spring settles and reverses. A short movement should never take longer than the user's next action.

## Keep transitions continuous

Open, close, and reopen a component before its animation finishes. It should continue from its current position without jumping back to its starting frame. While an element animates out, make sure it cannot receive focus or clicks.

Start entrances from something visible. An element scaling from `scale(0)` appears out of nowhere; `scale(0.95)` with `opacity: 0` reads as the same object arriving. Use percentage translations such as `translateY(100%)` for drawers and toasts so the distance follows the element's own size.

Scale a popover from its trigger by setting `transform-origin` to the trigger's side; most popover libraries expose the right value as a CSS variable. A modal has no trigger anchor and scales from its center.

If press feedback suits the design, keep the scale subtle, around 0.96–0.98. A color or border change may be enough for a compact control. Disabled controls should not react to presses. Do not scale whole panels or text-heavy surfaces.

When an icon swaps state, such as copy to copied, keep the control's size and accessible name stable. A short cross-fade with slight scale can smooth an occasional swap; a tab icon in a frequently used toolbar should change instantly. Hide the duplicate visual layer from assistive technology. Do not animate a component's initial state just because it mounted; in Motion, `AnimatePresence initial={false}` prevents this.

Tooltips should wait briefly before the first one opens to avoid accidental triggers. Once one is open, moving to a neighbor should show its tooltip immediately and without animation.

## Treat gestures as interactions

Use pointer capture when a drag must continue outside its starting element. Handle `pointercancel` and lost capture so the interface never stays stuck mid-drag. Let the page scroll on the axis the gesture does not use with `touch-action: pan-y` or `pan-x`; `touch-action: none` on a large area traps scrolling. Ignore extra pointers in a single-pointer gesture, or switching fingers will make the element jump.

Swipe-to-dismiss can use both distance and release velocity, so that a quick flick dismisses as well as a long drag. Tune thresholds on the actual component and device, test for accidental dismissal, and do not copy a velocity constant from another codebase. Always provide a visible close button or another non-drag path. When a drag reaches a boundary, increasing resistance explains the limit better than a hard stop.

## Respect motion preferences

Give every animation a reduced-motion path. Remove nonessential movement, scaling, parallax, and blur. Keep a short opacity change or switch states immediately, whichever communicates the result more clearly. Every animated state change still needs a static cue, such as a color, icon, or label, so nothing depends on seeing the motion.

```css
@media (prefers-reduced-motion: reduce) {
  .menu {
    transform: none;
    transition: opacity 150ms ease-out;
  }
}
```

Wrap decorative hover motion in `@media (hover: hover)`, because touch devices apply `:hover` on tap and leave it stuck. Never hide information behind hover movement.

Motion that starts automatically, lasts more than five seconds, and runs alongside other content needs a way to pause, stop, or hide it unless it is essential. Stop nonessential loops when they are offscreen or the page is hidden, and show a still frame under reduced motion. Avoid flashing content and unexpected sound.

## Diagnose performance from evidence

When an animation stutters, find out what work happens on each frame before adding `will-change`. Common causes are animating layout properties, large paint areas, long main-thread tasks, React state updates on every frame, and too many simultaneous effects. Updating an inherited CSS variable on a parent can cause style recalculation through its subtree. If that is the drag's bottleneck, set `transform` on the moving element directly.

Read layout values before writing styles, so the browser does not recalculate layout repeatedly. Keep high-frequency values out of React's render cycle, using refs, motion values, or direct style updates. Declarative CSS animations or WAAPI can stay smooth when the main thread is busy, but confirm this in the actual browser. Add `will-change` only for a measured problem, on the element that animates, naming the animated property, and remove it when the animation ends.

## Check the motion

Watch each changed animation at normal speed first, then slow it down in the browser's animation tools to see how its parts line up. Toggle it rapidly, interrupt it, and repeat it. Turn on reduced motion and confirm the result still makes sense. Exercise changed gestures with real or simulated touch. Profile in representative conditions; CPU throttling on a laptop does not reproduce a phone's GPU and memory limits. Report which browser and input methods you checked and which device behavior remains unverified.
