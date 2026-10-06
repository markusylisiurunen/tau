---
name: "clear-writing"
description: "Write, rewrite, or review text so it reads like a knowledgeable person explaining something to a respected colleague: plain, direct, precise, and free of AI writing habits. Use for any text, including documentation, skills, prompts, pull requests, blog posts, and messages. Trigger: eager."
---

Use this skill when writing new text, rewriting existing text, or reviewing someone else's writing. It applies to any writing: documentation, agent instructions, skills, pull request descriptions, commit messages, comments, chat replies, and technical blog posts. The request decides what to produce. When it asks for a rewrite, follow the rewriting section as well.

## The target voice

Write as a thoughtful person who knows the subject well, explaining it to a respected colleague. In engineering text, picture an experienced engineer; in a blog post, picture the same person writing for interested readers outside the team. The reader is intelligent and busy. They want the point, the reasons that matter, and enough detail to act correctly or follow the argument.

Good writing in this style is plain and direct. Each sentence makes one clear claim in ordinary words, usually with a concrete subject and an active verb. The tone is calm and confident, without salesmanship or drama. Instructions read as instructions. Emphasis comes from what is said and where it is placed, so intensifiers and bold text are rarely needed.

Assume the reader may not be a native English speaker. Abstract nouns, idioms, rare words, and long sentences cost a non-native reader far more effort than a native one, and that effort adds up quickly over a whole document. Prefer common words and literal phrasing. Each sentence should be understandable on the first read without a dictionary.

Plain does not mean simplistic. Keep every distinction the reader needs, and state limits, exceptions, and degrees of certainty exactly. Precision matters more than brevity, and brevity matters more than polish.

## Structure and formatting

Choose the form that makes the content easiest to read. Paragraphs suit reasoning, explanation, and anything where the connections between points matter. Structure suits content that already has structure:

- Bulleted lists for parallel items a reader may scan or check off, such as options, requirements, or findings.
- Numbered lists for steps that happen in order.
- Tables for comparing several items across the same attributes.
- Code formatting for commands, code, identifiers, and exact output.
- Headings in longer documents, so readers can find the part they need.

Write each list item as a complete thought in the same plain style. If the points depend on each other through "because", "so", or "unless", write a paragraph instead, since a list would hide those connections. Keep formatting in proportion to the length of the text: a three-sentence reply needs no headings.

## Habits to remove

AI-written text tends to share a recognizable set of habits. Each one is defensible in isolation, but together they make text tiring to read and harder to trust. Look for them while writing and while reviewing.

**Contrast framing.** "It's X, not Y", "This is X, not Y", "X rather than Y", and "not just X, but Y" used as a default sentence shape. State the positive claim directly. Keep a contrast only when the reader would otherwise make that specific mistake, and then usually give it its own sentence.

- Before: "This skill supplies a reasoning method, not an execution mode."
- After: "This skill provides a way of reasoning. The request that invokes it decides what to do with that reasoning."

**Slogans and aphorisms.** Sentences built to sound quotable, often closing a paragraph: "The goal is a coherent model, not uniformity for its own sake." If the sentence carries a real point, state it plainly. If it only restates the paragraph, delete it.

**Commentary about the text itself.** "This is a reasoning discipline, not a mandatory output section." "This is iterative design, not an obligation to…" Turn these into the instruction they are trying to give: "Treat this as a check on your own reasoning; it does not need to appear in the output."

**Abstract, stiff register.** Nominalizations and formal phrasing where a verb would do: "exercise judgment", "carry forward accumulated knowledge", "the size of the necessary redesign is not a reason to settle for a worse outcome". Use concrete subjects and ordinary verbs: "use judgment", "bring along what has been learned", "the size of the redesign is never a reason to settle for a worse outcome". Keep the real terms of the field, since the reader needs them, and replace words that only sound formal.

**Overloaded sentences.** Several clauses chained with semicolons, colons, and qualifiers until the reader has to parse the sentence twice. Split it. One sentence, one claim.

**Reflexive lists of three.** "Clear, concise, and actionable." Use as many items as there actually are. If two adjectives mean nearly the same thing, keep the more precise one.

**Intensifiers and filler qualifiers.** "Genuinely", "truly", "meaningful", "deeply", "real", "robust", "seamless" sprinkled for weight. Keep a qualifier only when it separates one thing from another, as in "real constraints" versus constraints that are side effects of the current code.

**Signposting and throat-clearing.** "It's important to note that", "Ultimately", "In other words", "At its core", "Let's dive in". Delete them and start with the point.

**Repetition across sections.** The same principle restated in the introduction, the body, and the conclusion with slightly different words. Say it once where it belongs. Repeat it only when a later section applies it in a new way.

**Typographic tics.** Em dashes as the default connector, bold on every other phrase, and headings that announce what the paragraph will say anyway. Prefer commas, parentheses, colons, or separate sentences. Use bold for terms a reader might scan for.

## Longer examples

These show several habits at once and how a rewrite handles them.

Agent instructions, before:

> Mentally set the implementation aside and ask: given what we need and know today, what would we build from a clean slate? Ask which pieces should exist at all, not just how to improve the pieces already there. Existing structure should carry little weight in choosing that design; its value is in the knowledge it reveals about the problem, edge cases, and real obligations.
>
> This is a clean slate for design, not for understanding, and not an instruction to delete code before learning from it. Let the preferred design determine what survives rather than letting existing code determine the design.

After:

> Set the current implementation aside and ask what you would build today, from a clean slate, given what is needed and known now. That includes asking which pieces should exist at all, in addition to how the existing pieces could improve. Give the existing structure little weight when choosing the design. Its value lies in what it reveals about the problem, its edge cases, and its real obligations.
>
> The clean slate applies to design only. It is no excuse to skip understanding the existing code, and code should never be deleted before you have learned from it. The preferred design decides what survives, and the existing code does not get to decide the design.

The rewrite removes three contrast frames, splits the semicolon sentence, and turns the commentary ("This is a clean slate for design, not…") into direct instructions. Every point survives with the same strength.

Blog post, before:

> Moving to Postgres-backed jobs wasn't just a technical change — it was a shift in how we think about reliability. At its core, the old Redis queue optimized for throughput, not correctness; jobs could vanish silently during deploys, and recovering them required manual, error-prone intervention. The new design is simple, robust, and transparent: every job is a row, every state transition is a transaction, and every failure is visible. It's not about speed. It's about trust.

After:

> We moved our background jobs from Redis to Postgres. The Redis queue was built for throughput, but jobs could disappear during a deploy without any error, and recovering them meant someone searching through logs by hand. Now each job is a row in a table, and each change to its state happens in a transaction. If a deploy interrupts a job, the job is still in the table afterwards, so nothing disappears. We gave up some speed, and in return every job either finishes or shows up as a visible failure.

The rewrite drops the opening "not just X, it was Y", the signposting ("At its core"), the list of three adjectives, and the slogan ending. It replaces abstractions ("a shift in how we think about reliability", "error-prone intervention") with what actually happens, which also makes the paragraph much easier for a non-native reader.

Design proposal, before:

> The ingestion pipeline exhibits non-deterministic latency characteristics under elevated concurrency, attributable to contention on the shared connection pool. To ameliorate this, we propose instantiating a per-tenant pooling abstraction, thereby facilitating isolation of resource utilization and obviating cross-tenant interference. This approach leverages existing primitives and necessitates minimal modifications to the orchestration layer.

After:

> When many imports run at the same time, they sometimes slow down by an unpredictable amount. The cause is that all customers share one pool of database connections, so a busy customer can use up connections that others need. We propose giving each customer their own pool. A busy customer would then slow down only their own imports. The change reuses our existing pooling code and needs only small changes to the code that schedules jobs.

The rewrite replaces words that only sound formal ("exhibits", "ameliorate", "obviating", "leverages", "necessitates") with everyday ones, and turns abstractions ("latency characteristics", "isolation of resource utilization") into what actually happens. It keeps "pool of database connections" because that is the precise technical term, and the reader needs it. The rule is to cut unnecessary difficulty, not to remove real terminology.

## Rewriting existing text

A rewrite changes how the text reads and keeps what it says. Readers of the original and the rewrite should come away with the same points, weighted the same way.

1. Read the whole text first and note its points, their order, and how strongly each is stated.
2. Rewrite section by section. Keep the structure unless it actively hurts comprehension.
3. Compare the result with the original line by line. Look for drift in:
   - **Strength.** "May", "can", "usually", "probably", and "never" are meaning. A rewrite that turns "may" into "probably" or "can be acceptable" into "is acceptable" has changed the claim.
   - **Scope.** Check that a rule still covers the same cases, no more and no fewer.
   - **Emphasis and ordering.** If the original insisted on something ("only after", "never"), the rewrite should insist too.
   - **Omissions and additions.** Every point should survive, and nothing new should appear by accident. Watch for added absolutes such as "fully" or "always".
   - **Contradictions.** A smoother sentence can conflict with another part of the text, so check each change against the whole.
4. Fix any drift you find. A deliberate change of meaning is fine when it makes the text clearly better, for example by resolving an ambiguity or removing a contradiction. Make those changes on purpose and tell the requester what changed and why.

## Reviewing text

When asked to review, point to specific passages, name the habit or problem, and propose replacement wording. Prioritize problems that affect meaning or comprehension over stylistic ones. Do not rewrite text that already reads well.

## Final check

Read the result once as its intended reader. Each sentence should say something, and the whole should be understandable on the first read. Before finishing, scan specifically for contrast framing and slogans; they are the habits most likely to survive a rewrite.
