# Layout and type

Make the hierarchy visible through grouping, alignment, spacing, and type. Start from the content and its reading order. Adjusting individual values rarely fixes a structure that is wrong.

## Group by meaning

Put related things close together and separate distinct groups more generously. The difference between the two intervals is what shows the grouping, so use a few clearly different steps. For example, on a 4px scale a form might use 4–8px between a label and its input, 16–24px between fields, and 40–48px between sections. When every gap is 16px, the sections dissolve into one list.

Give a heading more space above than below so it attaches to the content it introduces. Try alignment and proximity before adding a border or a card.

Match density to the task. An operations table can show many rows with compact spacing; an onboarding decision needs room. Use whitespace to show grouping and priority. Uniform padding everywhere makes unrelated groups look equally important.

Use the project's spacing scale. If none exists, pick a small set that covers tight component spacing and larger section spacing; a 4px base gives useful small steps. Use Grid and Flexbox for relationships, `gap` for spacing between siblings, and logical properties such as `margin-inline-start` where layouts must support both reading directions.

To check the hierarchy, blur the page or view it zoomed out. The primary element, the supporting groups, and the reading path should still be visible. If they are not, change the structure; resizing a few headings will not help.

## Adapt the structure

At smaller sizes, decide how the information should reorganize: which columns stack, which navigation collapses, which controls wrap, and which regions scroll on purpose. Shrinking everything proportionally is rarely the answer. Keep essential information and actions available at every supported size.

Let the content decide breakpoints, and check the widths between named device sizes, where layouts most often break. Use container queries for a component that appears both in a sidebar and at full width. Use `env(safe-area-inset-*)` for fixed controls near notches and screen edges.

Keep DOM order, visual order, and focus order in agreement. Do not use CSS `order` or grid placement to build a mobile layout whose keyboard order no longer makes sense. Do not hide horizontal overflow to cover a broken layout. A wide data table can have its own scroll region; an ordinary form should reflow.

Flex and grid children often need `min-width: 0` before they can shrink below their content. Wrap long user content and unbroken strings such as URLs and IDs with `overflow-wrap: anywhere`. Truncate only when the shortened text is still enough for the task and the full value is available to keyboard and screen-reader users. A hover-only tooltip is not enough.

## Define type roles

Use a small set of roles, such as page title, section heading, body, label, metadata, and data, and use each role the same way on every screen. Distinguish roles with a combination of size, weight, spacing, and color. Size alone produces a ladder of nearly identical steps that nobody can tell apart.

Working tools usually do best with one family, a fixed `rem` scale, and modest steps between sizes (a ratio around 1.125–1.2). A heading that grows and shrinks with the viewport looks odd in a dense app. Marketing pages can use larger, more expressive display type, and fluid sizing with `clamp()` can suit a broad composition there.

For ordinary web body text, start at 1rem (16px by default). Dense metadata can go smaller when the face, contrast, and task allow it. Respect zoom and user font settings, and never shrink text to make a layout fit.

For long reading, aim for roughly 45–75 characters per line and tune the measure to the language and face; `max-inline-size: 65ch` is a reasonable start. Body line height around 1.5 works for most sans faces. Wider lines need more leading, and headings need less. Judge the actual glyphs and copy rather than applying ratios mechanically.

Load real weights instead of letting the browser synthesize bold or italic. Avoid tight letter-spacing on small text. Light text on a dark background looks heavier and tighter than the same settings in light mode, so check it separately; it can need slightly more line height or a lighter weight.

## Design with the real text

Use representative copy while designing. A layout that only works with a two-word title is unfinished if users can enter longer ones. Check empty values, long names, translated labels, and large numbers where they can occur. Translated text is often a third longer than English, and one long German compound word may not fit where the English label did.

Use `font-variant-numeric: tabular-nums` for numbers people compare in columns or watch change, so digits do not shift width. Format dates, numbers, and currency for the user's locale with `Intl` or the project's formatter. Keep a value and its unit together with a non-breaking space where a line break would confuse the meaning. Use monospace for code and for data that benefits from aligned characters, and avoid it as decoration for a "technical" look.

Use `text-wrap: balance` on short headings so a single word does not end up alone on the last line, and `text-wrap: pretty` on body text where it helps. Avoid manual line breaks that only work at one width. Use sentence case and plain wording unless the product has a different convention.

## Load fonts and images without layout shift

Load only the families and weights the surface uses. Keep text visible while fonts load (`font-display: swap` or `optional`), and choose fallbacks with similar metrics, or adjust them with `size-adjust`, so the swap does not reflow the page. Preload only the font files the first view needs.

Reserve space for images with `width` and `height` attributes or `aspect-ratio`. Serve appropriately sized sources. Lazy-load images below the fold, but load the image that carries the first viewport eagerly. Keep essential content usable when an optional image fails.

## Check the composition

Inspect narrow, intermediate, and wide layouts with real content. Include 200% zoom and a larger default font size. Look for clipped text, groups that split apart, controls hidden behind sticky elements, and heading wraps that distort the hierarchy. Check each supported theme and reading direction. Use a few representative extremes; an exhaustive set of hypothetical strings adds little.
