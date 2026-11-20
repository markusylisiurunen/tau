---
label: "upgrade Tau dependencies"
---

Bring all dependencies in this repository up to date. Perform the upgrade completely; do not only recommend versions, and do not commit.

Tau has independent package roots at `/` and `/src/diff_tool/app`. In both, upgrade each outdated direct dependency to the newest eligible release by semver. Check published versions as well as npm's `latest` tag. Stable dependencies take only stable releases. If a dependency is already on a prerelease, also consider newer prereleases with the same major and prerelease identifier. For example, `5.0.0-beta.2` can move to `5.1.0-beta.1` or a newer stable release, but not to `5.0.0-rc.1` or `6.0.0-beta.1`. Never downgrade to an older release just because npm tags it as `latest`.

Preserve the manifest's existing pin or range style and regenerate both lockfiles with npm 12. Include compatible transitive lockfile updates, but do not add overrides for versions owned by upstream packages.

Apply these repository-specific constraints:

- Keep `@types/node` on Tau's supported Node LTS major, as established by the root `engines` field and installed Node. Upgrade within that major rather than taking a newer non-LTS major.
- For `pi-ai` or `pi-tui`, refresh the read-only `references/repos/pi` checkout, review upstream release notes and exported API changes, then update Tau for any API or behavior changes.
- For `ses`, verify code mode and its sandbox assets. Keep version-coupled configuration such as the Biome schema and npm `allowScripts` entries aligned with installed versions.
- Review new or changed install scripts using `npm approve-scripts --allow-scripts-pending`. Approve only understood, required scripts and pin approvals to exact versions. Preserve npm 12's strict script policy.
- Review release notes for breaking changes, peer and engine requirements, both lockfile diffs, and `npm audit` results. Fix upgrade-related compatibility issues without unrelated cleanup.

Confirm a clean `npm ci` succeeds in each package root. Then run `npm run check`, `npm run build`, and `npm test` from the repository root, in that order. Finish only when these checks pass, or report a concrete external blocker. Summarize upgraded versions, material compatibility changes, audit findings, and verification results.
