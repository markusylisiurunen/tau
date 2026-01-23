---
id: release-patch
description: release a new patch version
---

make a new patch release of tau:

- ensure you are on `main` with a clean working tree. unpushed commits are fine because the release command pushes them.
  - if not, ask the user what to do
- run the following commands:
  - `npm run check && npm run build && npm test`
  - `npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes`
