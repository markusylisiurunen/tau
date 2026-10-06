---
enabled: true
schedule: "15 5 * * *"
timezone: Europe/Helsinki
persona: gpt-6.1-sol-chatgpt-coder
reasoning: medium
---

Maintain one open pull request containing Tau's non-major npm dependency upgrades.

Read the repository's dependency-upgrade guidance in `AGENTS.md` and the applicable nested guidance. Check every package root, currently the repository root and `src/diff_tool/app`, using supported npm commands from the correct working directory. Upgrade direct dependencies to the latest stable versions whose numerical major component matches the current version, including later `0.x` releases for dependencies currently below 1.0. Update each affected `package.json` and `package-lock.json`, refresh compatible transitive dependencies, and review `npm audit` in each root. Do not override upstream-owned versions or cross a direct dependency's major version. Record available direct major upgrades, including current and latest versions, in the pull request description.

Follow the repository's special handling for `@types/node`, Pi packages, `ses`, and version-coupled configuration such as the Biome schema and `allowScripts` keys. When an allowed upgrade requires API changes, migrate cleanly while preserving behavior and architecture. If an upgrade cannot be completed cleanly, omit it and explain the constraint in the pull request description. Do not change Tau's own package version or publish a release.

Before making changes, use one complete `gh` listing of open pull requests authored by the current bot, retrieving each number, title, branch, and body without relying on a search query or fetching candidates one by one. Identify the maintained pull request only by this exact final-line marker:

`<!-- cowork-schedule: dependency-maintenance -->`

If one exists, read its reviews and discussion, continue on its branch, and update it rather than opening another. Preserve intentional changes, incorporate the current default branch without rewriting published history, and account for review feedback. Otherwise, start from the current default branch and open a pull request only when there are eligible upgrades to commit. Use a short lowercase dash-separated branch name describing dependency maintenance, without dates or individual dependency names.

Keep all upgrades in this one pull request. Follow the repository's pull request conventions, use a concise title describing the current batch, and keep the description accurate to the current diff. List available but unapplied major upgrades and intentionally omitted upgrades, and retain the marker as the final line. Update the title and description when the diff or upgrade report changes; do not post routine refresh comments.

Before committing, verify clean installation in both package roots with `npm ci --strict-allow-scripts`, then run `npm run check`, `npm run build`, and `npm test` from the repository root in that order. Inspect formatting and generated changes, resolve upgrade-related failures, and verify the actual working tree that will be committed. Do not publish or update the pull request unless the complete branch is coherent and all applicable local checks pass. If there is no existing marked pull request and nothing eligible can be upgraded, make no GitHub changes.
