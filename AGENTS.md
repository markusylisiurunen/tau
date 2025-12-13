# Repository Guidelines

## Project Structure & Module Organization

- `src/`: TypeScript source (ESM). Entry point is `src/main.ts`.
- `src/session/`: core session logic (message accumulation, turn processing).
- `src/tools/`: tool definitions and registry (e.g., bash execution or editing files)
- `src/ui/`: terminal UI components (rendering, themes, slash autocomplete, message views).
- `src/utils/`: small shared helpers (e.g., fuzzy matching, truncation).
- `dist/`: build output from TypeScript (`npm run build`). Do not edit by hand.
- `bin/`: local helper binaries (ignored by git).

## Build, Test, and Development Commands

- `npm install`: install dependencies (requires Node `>=20`).
- `npm run dev`: run from source via `tsx` (fast iteration).
- `npm run build`: compile TypeScript to `dist/` using `tsc`.
- `npm start`: run the compiled CLI from `dist/`.
- `npm run check`: auto-format/lint with Biome + typecheck (`tsc --noEmit`).
- `npm run fmt`: format the repo with Biome.
- `npm run lint`: lint with Biome (no writes).

## Coding Style & Naming Conventions

- Formatting/linting: Biome (2-space indent, line width 100). Prefer `npm run check` before pushing.
- TypeScript: keep types in `PascalCase`, values/functions in `camelCase`, and files `lowercase.ts` (as in `src/app.ts`).
- Keep OS-specific behavior isolated (clipboard uses `pbcopy`, so macOS assumptions belong in `src/clipboard.ts`).

## Testing Guidelines

There is no dedicated test runner in this repo currently. Validate changes by:

- `npm run check` (format + lint + typecheck)
- manual smoke tests: `npm run dev` and a full build/run (`npm run build && npm start`)

## Commit & Pull Request Guidelines

- Commit messages follow a simple imperative style (examples from history: “add …”, “implement …”, “update …”).
- Keep commits focused; avoid bundling formatting-only changes with behavior changes unless necessary.
- PRs should include: what changed, how to reproduce/verify in the terminal, and any relevant notes about tool-access behavior (`/tool:none|read|all`) or API key usage.

## Security & Configuration Tips

- Never commit secrets. Use env vars like `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for local runs.
- Treat any changes to shell/tool execution paths as security-sensitive: document defaults and failure modes in the PR description.
