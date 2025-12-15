---
id: release-patch
description: release a new patch version
---

make a new patch release of tau:

- ensure you are on `main` with a clean working tree
  - if not, ask the user what to do
- run the following commands:
  - `npm run check && npm run build`
  - `npm version patch`
  - `git push --follow-tags`
  - `gh release create v$(node -p "require('./package.json').version") --generate-notes`
