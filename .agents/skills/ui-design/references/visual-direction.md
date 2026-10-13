# Visual direction

Choose a direction from the product's subject, audience, and purpose. People should recognize what the interface is for before they notice its styling.

## Start from the brief

Identify the main task or message, the content that supports it, and the constraints that shape the experience. Read existing brand guidance and inspect representative screens. When extending an established product, keep its confirmed assets and conventions. Ask about a missing fact only when it would change the work and cannot be resolved from context. Otherwise make a reasonable assumption and state it.

When the brief specifies a look, era, palette, or typeface, follow it, even when it matches a common default described below. The brief's words outrank your taste.

Separate product facts from design freedom. Do not invent customer logos, testimonials, usage numbers, prices, or capabilities to fill a composition. If a prototype needs sample data, make it representative and keep the interface looking finished. Do not label sample data in the UI. Instead, say outside the UI which content is sample data and which production assets are still missing, so nobody mistakes the result for finished work.

## Write the direction down

Before building, describe the direction in a few concrete sentences: who uses the surface and in what situation, what leads, and the handful of rules for type, color, density, and imagery. Keep it to yourself unless the workflow asks for it. Its purpose is to make the choices specific enough to check.

A vague direction gives nothing to check against:

> Modern, clean, and professional, with a friendly feel.

A useful one names decisions that could be wrong:

> An incident console for on-call engineers, often used at night. Dark neutral surfaces with one red reserved for active incidents. A single sans family, with monospace only for log lines and IDs. Dense tables, no decorative imagery. The open incident and its next action lead every screen.

If the description would fit an unrelated product after changing the name, revisit the main choices.

## Choose what leads

Decide what a person should understand or do first, then pick the element that makes that possible. In a tool it may be the current task, a selected record, or a useful overview. In an article it is the title and the text. On a marketing page it may be the product at work, a photograph, a strong headline, or an interactive demonstration.

Give the leading element the space and contrast to lead, and let the rest explain or support it. When every card, badge, and button competes for attention, nothing leads.

The same product can need different compositions. A deployment dashboard leads with failed deployments and a recovery action. The landing page for the same hosting service leads with a demonstration of deploying an app, because the visitor's job is different.

## Build a small visual language

Choose a few rules for type, color, spacing, imagery, and surfaces, and apply them consistently. Established products already have these rules in their tokens and components. For a new identity, make the choices specific to the brief.

Typography carries much of the character. One well-chosen family is often enough. Add a second only when it has a distinct role, such as display headlines or code, and make the two clearly different. Use real subject matter and useful imagery where they explain more than decoration can.

Spend expressive choices in one place. A distinctive focal element works best when the material around it stays quiet. In a frequently used tool, the character usually comes from clear information and precise interactions, with very little decoration.

## Use color as a set of roles

Define color by job before picking values:

- canvas and raised surfaces
- primary and secondary text
- action, focus, and selection
- borders and separators
- success, warning, error, and information
- data categories or scales, when the product shows data

In working tools, keep the accent for primary actions, the current selection, and state. An accent that also decorates headings and icons stops pointing at anything. Expressive surfaces can let a strong color own a whole region, as long as the next action stays easy to find. Keep semantic colors consistent across the product, and follow domain conventions where they exist (in some financial markets, red means a rising price).

For a new web palette, OKLCH makes lightness and chroma easier to adjust predictably. Reduce chroma near white and black instead of forcing the same saturation across a ramp. On a colored surface, derive secondary text from that surface's hue; a generic gray often looks dirty there. Prefer explicit colors over stacks of translucent overlays, because alpha makes contrast depend on whatever sits behind.

Design a dark theme as its own composition. Inverting a light theme usually produces glowing borders, muddy shadows, and accents that are too saturated. In dark themes, show elevation with lighter surfaces, since shadows barely register. Choose light or dark as the default from where and when people use the product, not from its category.

## Question unexamined defaults

Some patterns appear regardless of subject: identical rounded cards with the same soft shadow, gradient washes, a big number with a small label and an accent, a small uppercase label above every heading, decorative grid backgrounds, `01 / 02 / 03` section markers, and the same fade-up on every section. Each is right for some brief. Before using one, ask what it communicates here.

Replacing one template with another does not solve the problem. A cream page with an editorial serif, a black page with one acid-green accent, and a dense broadsheet with hairline rules are also common defaults. Familiar controls and system fonts can be exactly right for a working tool.

Use a container when it marks a real boundary: an item people act on independently, a group of settings, or a surface above another. When spacing, alignment, and headings already show the relationship, a card adds noise. Avoid cards inside cards. Number items only when the order or rank matters. Remove labels that only decorate.

Copy is part of the direction. Name things the way users think of them ("Notifications", not "Webhook config"). Describe what something does instead of selling it.

## Check the direction

Judge the full page and the first viewport at normal reading size. Can a person tell what the product is, what matters most, and what to do next? Does the character survive long content, empty states, and less attractive data? Fix those problems before tuning shadows and corner radii.
