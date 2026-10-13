# Polish

Polish refines a design that already works. It comes after the task, hierarchy, and interaction are sound, and it keeps the product's identity and the request's scope. If the composition itself is wrong, say so before adjusting details.

## Fix inconsistency where it originates

Compare the target with related controls and screens. The same detail done two ways in one product is a real finding; a deliberate convention, such as a flat style without shadows, is not. For each mismatch, work out whether it comes from a local value, a missing shared variant, or a structural problem. Use an existing token or component when it expresses the same concept. Add a shared value only when several places share its role.

Make repeated elements consistent before perfecting one corner. Save buttons serving the same role on two screens should use the same treatment; a different level of emphasis needs a reason.

## Check geometric and optical alignment

Start with the grid and spacing scale, then look at the rendered result. Mathematically centered shapes can look off: a play triangle looks too far left because most of its area sits on the flat side, and an icon next to a label can sit visually high. Fix the asset or the shared component where possible. Make a small optical adjustment only when the rendering actually needs it.

Keep these corrections in one place. Spreading compensating offsets through every caller makes the next change harder. A button with an icon often looks balanced with 2px less padding on the icon side. Treat that as a starting point and confirm it by eye. Check the smallest supported size and both reading directions.

For nested rounded surfaces with an even inset, make the corners concentric:

```text
outer radius = inner radius + padding (+ border width)

inner radius 12px, padding 8px, border 1px  →  outer radius 21px
```

With large or deliberately uneven padding (beyond about 24px), the layers read as separate surfaces and can keep their own radius tokens. Matching radii on nested surfaces is a reason to look closer, not proof of a defect.

## Make surfaces express structure

Use borders for necessary boundaries: separators, table cells, selected states, and form inputs, whose edges need 3:1 contrast. Use shadows when elevation explains layering, such as a menu above the page. Pick one way to define a surface's edge. A 1px border under a wide soft shadow usually looks blurry, unless each has its own job.

Layered shadows, such as a tight shadow for the edge plus a soft one for depth, look more natural than one large dark shadow. Tune them per theme; a shadow tuned for light mode disappears on a dark background, where lighter surfaces show elevation better.

Forced-colors mode removes shadows. If a shadow ring draws a control's edge, add `border: 1px solid transparent` so the system can paint a visible border in that mode. Never let a shadow be the only focus indicator.

Content images on a matching background can use a faint outline to separate them, drawn in pure black or white at low opacity:

```css
img.content {
  outline: 1px solid rgb(0 0 0 / 0.1);
  outline-offset: -1px;
}
```

Use `rgb(255 255 255 / 0.1)` in dark themes. A tinted or brand-colored outline shows as a colored fringe. Skip transparent artwork such as logos and illustrations.

## Keep icons coherent

Use one icon family per surface and match its apparent stroke and size to the adjacent text. A heavier label needs a heavier stroke. Use the library's size-specific drawings when they exist; a detailed 24px icon can turn to mush at 16px, and a simpler glyph works better than offsets or sharpening tricks. Use drawn icons from a library or authored SVG. Emoji and Unicode symbols render differently on every platform.

Use `currentColor` for monochrome icons so hover, selected, and disabled states come from the same color rules as text. Multicolor artwork and brand logos keep their own colors. Outline and filled variants can mark selection when the icon set supports that consistently.

In right-to-left layouts, mirror icons whose meaning follows reading direction, such as back arrows and list indentation. Do not mirror logos, media playback controls, or clocks. Avoid flipping an icon twice when a composite component already mirrors it. Keep accessible names and selected-state semantics independent of the drawing.

## Check every visible state

Look at each state the component can reach: rest, hover, focus, pressed, selected, disabled, busy, success, and error. Each should be distinguishable without relying on motion or color alone. Keep dimensions stable when labels or icons change, so a button does not resize when "Save" becomes "Saving…".

Check every supported theme as its own design. Include native controls, focus outlines, text selection, and scroll areas. Set `color-scheme` so built-in controls and scrollbars match the theme. Style selection, scrollbars, or the caret when the design calls for it; leave them alone when the defaults already fit.

If switching themes makes every color transition fire at once, disable transitions for the moment of the switch using the project's mechanism, such as `disableTransitionOnChange` in `next-themes`. Do not add global transition machinery when there is no visible problem.

Overlays must escape ancestors with `overflow: hidden` and appear in the right stacking layer. Use the project's portal, the native `popover` attribute, or `<dialog>`. Give scrollable dialogs, drawers, and menus `overscroll-behavior: contain` so reaching the end does not scroll the page behind them. Do not disable page scrolling or native navigation globally to work around this.

On touch devices, set `-webkit-tap-highlight-color: transparent` on controls that draw their own pressed state, so the default gray flash does not double it.

## Finish the path

Check copy against the product's vocabulary, so each action has the same name wherever it appears. Remove placeholder claims and labels that do no work. Missing, long, translated, and permission-limited content should still look intentional.

Look at the changed area at normal size first. Check alignment, theme contrast, image loading, focus, and the relevant states at representative widths, and use the controls instead of judging a screenshot. Batch corrections into one pass. Then read the final diff for accidental global changes, leftover experiments, and redundant overrides. Report important behavior you could not verify, and keep the work inside the requested scope.
