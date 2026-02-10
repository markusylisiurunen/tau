---
id: "release-patch"
description: "release a new patch version"
---

Make a new patch release of tau:

- Ensure you are on `main` with a clean working tree. Unpushed commits are fine because the release command pushes them.
  - If not, ask the user what to do.
- Run the following commands:
  - `npm run check && npm run build && npm test`
  - `npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes`
