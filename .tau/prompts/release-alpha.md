---
id: release-alpha
description: release a new alpha pre-release (tagged as alpha on npm)
---

make a new alpha release of tau (published under the npm `alpha` tag, not `latest`):

- ensure you are on `main` with a clean working tree
  - if not, ask the user what to do
- run the following commands:
  - `npm run check && npm run build && npm test`
  - `npm version preminor --preid alpha && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease`
