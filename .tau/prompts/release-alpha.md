---
id: "release-alpha"
description: "release a new alpha pre-release (tagged as alpha on npm)"
---

Make a new alpha release of tau (published under the npm `alpha` tag, not `latest`):

- Ensure you are on `main` with a clean working tree. Unpushed commits are fine because the release command pushes them.
  - If not, ask the user what to do.
- Check the current version in `package.json`:
  - If it already contains `-alpha.`, bump the prerelease number.
  - Otherwise, create a new alpha preminor.
- Run the following commands:
  - `npm run check && npm run build && npm test`
  - `if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi`
  - `git push --follow-tags`
  - `gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease`
