---
id: release-alpha
description: release a new alpha pre-release (tagged as alpha on npm)
---

make a new alpha release of tau (published under the npm `alpha` tag, not `latest`):

- ensure you are on `main` with a clean working tree. unpushed commits are fine because the release command pushes them.
  - if not, ask the user what to do
- check the current version in `package.json`:
  - if it already contains `-alpha.`, bump the prerelease number
  - otherwise, create a new alpha preminor
- run the following commands:
  - `npm run check && npm run build && npm test`
  - `if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi`
  - `git push --follow-tags`
  - `gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease`
