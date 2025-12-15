---
id: release-minor
description: release a new minor version
---

make a new minor release of tau:

- ensure you are on `main` with a clean working tree
  - if not, ask the user what to do
- run the following commands:
  - `npm run check && npm run build`
  - `npm version minor`
  - `git push --follow-tags`
  - `gh release create v$(node -p "require('./package.json').version") --generate-notes`
