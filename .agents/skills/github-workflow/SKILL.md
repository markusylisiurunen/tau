---
name: github-workflow
description: "Apply consistent Git and GitHub practices for branches, commits, issues, pull requests, comments, reviews, and CI interactions. Load this skill proactively before any Git or GitHub work, including reading discussions, drafting text, creating commits, or publishing changes, even when not explicitly requested. Trigger: eager."
---

Read this skill before starting Git or GitHub work. Use skill `clear-writing` for all GitHub communication, including issue text, PR descriptions, comments, and reviews.

This skill supplies defaults. Follow a format or workflow specified by the user or repository instructions when it differs from these defaults.

## Scope and permissions

The request determines which actions to take. This skill does not by itself grant permission to act.

- Commit only when requested or called for by an active workflow. A commit request alone does not include pushing.
- A request to open or update a pull request includes the necessary branch creation, commits, push, and PR publication after verification. It does not include merging, deployment, or unrelated changes.
- Preserve unrelated staged and unstaged work. Inspect the working tree and intended diff before staging; include only changes within the requested scope.
- Never bypass hooks with `--no-verify`. Before amending, verify the commit is yours. Do not reset, restore, stash, rebase, or cherry-pick unless the user or active workflow calls for it. The next rule also permits the amend or rebase needed to update a PR.
- Updating a PR may require rewriting the history of its branch. A request to update that PR covers a necessary history update without another permission question, provided no one else's work is overwritten. Inspect the remote branch first and use `--force-with-lease` with the expected remote commit. Ask before rewriting shared-branch history or when ownership is unclear. Never force-push merely to bypass a rejected push.
- Follow a workflow's supplied branch name or required review format. Keep real repository-specific exceptions. Do not invent separate conventions for each repository.

## Writing style

By default, write like a developer talking to a colleague: plainly and briefly. Give enough context to understand the point without recounting the whole conversation. Use more detail when requested or needed to explain the change.

Use sentence case for issue and PR titles, headings, and prose: capitalize the first word and proper nouns, and write identifiers as they are spelled. Do not use title case or force prose into lowercase. Commit subjects follow the lowercase convention below.

Write for someone who has not followed the conversation. Explain the problem, the intended result, and important limitations, without retelling how the work went. Never publish credentials, private document URLs, or unrelated personal information.

## Branches and commits

Use a few descriptive lowercase words separated by hyphens for branch names, without category prefixes or issue numbers, unless the workflow supplies a name.

Keep commit subjects short, imperative, and lowercase, without a prefix or trailing period, for example `fix document reconnect handling`. Leave the body empty unless a single commit closes an issue without a PR. In that case, the body is only a closing-keyword line such as `fixes #123`. When opening a PR, put the closing reference in its body instead.

## Pull requests

Open pull requests ready for review by default. Reserve drafts for an explicit user request or work that is not yet ready for review. Pending CI or human review alone does not justify draft status.

Use a concise sentence-case title describing the change. Write the body in prose with these sections:

```markdown
## Why

The problem or need, and why the change matters.

## What

The resulting behavior and important decisions.
```

Add `## Details` only when useful for limitations, compatibility, rollout, or other consequential context. Avoid file inventories, activity logs, and lists of routine verification commands. Mention a verification gap when it affects confidence in the change. Include focused screenshots only when they make review noticeably easier.

End with a closing-keyword line when the PR resolves an associated issue. Do not close an issue for partial work; state what remains instead.

When updating a PR, base its title and body on the current complete diff against its target branch. Describe the resulting change. Remove descriptions of ideas or behavior that were dropped during development. Do not turn them into claims such as "Does not do X" just because an earlier revision did X. Mention a discarded approach only when it helps explain the final change.

## Issues, comments, and reviews

Read the complete relevant issue or PR discussion before acting. When responding to review feedback, include the review threads. Do not rely only on the opening description or a summary.

For a bug report, describe expected and actual behavior and the known reproduction steps. For a feature request, describe the desired outcome, scope, and constraints. Keep unknowns explicit and avoid prescribing an implementation before it has been investigated.

Choose a structure that fits the message. A short comment may need only a paragraph. A longer issue may benefit from headings, or from a template if one is requested. Keep comments focused on the question, decision, or change being discussed.

## GitHub operations

Use `gh` for GitHub operations. Omit `--repo` when the current checkout identifies the intended repository. Pass an explicit target when working across repositories. For an issue, read its body and comments with `gh issue view <id> --json closed,author,labels,title,body,comments`.

Pass multiline bodies through a quoted heredoc and `--body-file -`, using actual newlines:

```bash
gh pr comment 123 --body-file - <<'EOF'
The retry now preserves the original request ID.

This prevents duplicate writes when the connection drops after a successful response.
EOF
```

Read published or edited text back to confirm its content and formatting.

For image or video attachments, check the installed command's `--help` for supported flags and behavior. Recent `gh` versions support `--attach` on issue and PR comments, for example:

```bash
gh pr comment --help
gh pr comment 123 --body 'Updated error state.' \
  --attach './error-state.png#The error message beside the retry button'
```

Repeat `--attach` for multiple files. Image alt text follows `#` in the quoted argument; videos do not take alt text. Do not assume other commands or older versions support the same flags.

Do not check or monitor remote CI on your own. When asked to check CI, make the queries needed to answer the request. Do not turn a status check into ongoing polling or waiting for completion unless that was requested.
