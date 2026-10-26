---
name: "delegate-ui"
description: "Delegate a bounded frontend task to a Claude Code Opus peer that owns the UI decisions, the frontend code, and its verification, while you handle the backend, the running environment, and the combined result. The invoking request sets the scope and what the peer may do. Use only when the user explicitly names this skill or active instructions explicitly invoke it; do not activate merely because a task involves UI work. A peer that receives the UI assignment works directly and does not delegate again. Trigger: explicit."
---

With this skill, a Claude Code Opus peer does the frontend part of the task and makes its design decisions. You prepare everything around it, hand over the assignment, and check the combined result.

The request or instructions that invoke this skill define the task, how far to take it, and any constraints. The workflow that invokes this skill also sets the peer's limits. For example, a rapid-iteration workflow keeps its small edits and its ban on verification. A finalization workflow asks for finished code and its checks. A request for a plan or a critique keeps the peer read-only, so it returns findings and does not edit files. The invocation authorizes you to delegate the frontend part to one peer and grants no other permissions.

If you are the UI peer, do the assignment yourself using the `ui-design` skill, and do not delegate it again.

## Required peer

Use skill `subagents` to launch and supervise the peer. Where this skill sets more specific rules, such as for the model, the assignment, and the handoff, follow this skill.

Launch `claude-code/claude-opus-5-5:medium` through Tau's subagent support. Use exactly this model and effort level, and do not substitute another model or call the Anthropic API directly.

If the peer fails to launch or to finish, follow the fallback that the caller or the active instructions define. That fallback may tell you to do the frontend work yourself. If they define none, report the limitation, and do not do the frontend work yourself or delegate it to another model. Whenever you do take over the frontend work, state that it did not get the Opus pass, and inspect any partial edits before you continue.

## Divide the work

The peer owns the whole frontend part of the task: design decisions, frontend code, interface copy, interactions, accessibility, client state, and the use of existing APIs. Giving it only the appearance would split the same components between two agents.

You own everything around that part:

- Work out the goal and constraints with the user.
- Do the backend work and any other non-frontend changes that the authorized task needs. When the task includes frontend implementation, finish this work before you delegate.
- Run the environment when the peer needs a running app, for example to check the interface in a browser, and the project's guidance explains how to start it. Start the dev server and supporting services as that guidance describes, choose ports, check that they are ready, restart them when needed, and clean up afterwards. Leave services that were already running as they were. If the guidance does not explain how to start the app, do not work it out yourself, and let the peer work from the code. When the task is a plan, a critique from code, or work that the workflow forbids verifying, the peer can work from the code, so do not start services for it.
- Check the combined result at the end.

When the frontend work turns out to need a backend change or a new product or API contract, the peer asks you instead of making it. Settle the change with the user when it is a product decision, make it yourself, and then let the peer continue.

## Hand off

Delegate once the preparation that the task needs is done. Do not design the interface yourself beforehand, and do not sketch components, layouts, or controls in your prompt.

The peer starts fresh in the project and knows only what your prompt tells it. Start your first prompt to a new peer with the preamble below, and put the task-specific part after it. Later messages to the same peer do not repeat it, because the peer already has it.

> You are a UI peer for another agent that is working in this project. That agent has handed you the frontend part of a task and will review and integrate your result. The task below states what is already settled. Every other UI decision is yours: what the interface needs, how it looks and behaves, and how the frontend code implements it. Use the `ui-design` skill. Before you start, read the project's instructions, such as `AGENTS.md` files, and follow them. Read whatever code and surrounding interface you need. The other agent runs the dev server and supporting services. Do not start, restart, or stop servers yourself, even when a project skill explains how. If the task below gives you a URL, use it and the access details it gives. If the environment is unavailable or needs a restart, report it and wait. If the task gives no URL, work from the code and do not ask for one unless the task requires browser checks. When you check the interface in a browser, use the `agent-browser` skill. Also use any other skill that is relevant to the work, such as a project skill for local development. Verify only as far as the task below allows. If the work needs a backend change, a new API, or a product decision, ask instead of making it or inventing it. Do not delegate this task to another agent. When you finish, say what you did and which important parts you could not check in a browser. Separate what you saw in the browser from what you inferred from code, and mention anything the other agent should know.

After the preamble, write a short note in plain prose, as you would to a capable colleague. Describe the situation and leave the solution to the peer. Pass on:

- The user's original request, in their words when practical, and what they want the result to achieve.
- The issue or pull request you are working on, if there is one, and where to find related screenshots, discussion, and decisions, so the peer can read them itself.
- What you have already done and what is still pending, such as the backend changes, the API they expose, and where to find them.
- Decisions the user has made, including any specific UI choices they asked for.
- The workflow's limits on editing and verification, and any other boundaries on what the peer may change or do.
- When you run the app for the peer, its URL and any access details, such as a test account.

Your own ideas about which components to use, how to lay out the screen, or what the controls should be are not settled, however sure you are of them. Leave them out. Stated as requirements, they decide the design as surely as a mockup would, and the peer will follow your plan even where it would have found a better one. Point the peer to code and screens it can inspect instead of describing them, and pass on what it cannot read, such as what the user told you in conversation. The project's existing interface binds the peer, but let it read that interface itself.

This task description looks reasonable, but it decides the interface for the peer:

> Add a filter to the orders page. Put a dropdown above the table with a search field at the top and a checkbox for each status below it. Show the number of selected statuses on the button, and add a "Clear" link. Use the existing `Popover` component.

This task description states what is done and what remains:

> The user asked in issue #142: "Let me filter orders by status, I usually only care about the open and failed ones." I added a `status` query parameter to `GET /api/orders` that accepts several values, in `server/routes/orders.ts`. The backend part is done, so only the frontend remains. The app runs at http://localhost:5173, and you can sign in as `demo@example.com` with the password `demo`. This is a finished change, so verify it as the repository's guidance asks.

Give the whole frontend part to a single peer. Do not split it between several peers.

## Iterate

Keep later rounds with the same peer when practical. Pass on the user's feedback without changing its meaning. When the environment needs repair, fix it, then resume the same peer.

## Integrate the result

While the peer works, do not edit the files it is changing. Once the peer finishes, check that the result fits the request, the backend, and the rest of the work, and run the checks the workflow allows. When you report to the user, mention anything important that nobody checked in a browser, so they know what still needs a look. When the peer changed shared components or hooks, check their other users too. If an error is small and the fix is obvious, fix it yourself instead of sending it back. Send other problems back to the peer with evidence, and do not redesign its work to your own taste. The correctness of the combined result remains your responsibility.
