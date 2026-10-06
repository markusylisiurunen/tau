# SDK browser diff review

`startTauSdkDiffReview()` starts Tau's built-in browser review UI for an observed SDK session, without the TUI and without opening a browser. It takes the diff in the session's execution environment, creates the same review agent context that `/diff` uses, starts preparing the review context and reviewer guide right away, and starts an HTTP server, on loopback by default.

```ts
import { startTauSdkDiffReview } from "@markusylisiurunen/tau/sdk";

const review = await startTauSdkDiffReview({
  session,
  source: {
    kind: "git_diff",
    diffArgs: ["main...HEAD"],
  },
});

console.log(review.url);

try {
  const result = await review.result;
  console.log(result);
} finally {
  await review.close();
}
```

The source can instead be `{ kind: "patch_files", patchFiles, scopeLabel }`. Paths and Git arguments refer to the session's execution environment. A snapshot's patch can be at most 16 MiB; narrow the Git arguments or patch files if a larger diff is rejected. A plain working-tree snapshot includes non-binary untracked files of up to 4 MiB each, within that total. The optional `host`, `port`, and `signal` fields set where the HTTP server listens and let you cancel startup.

## Routing and lifecycle

The returned `url` is on the SDK client's machine and ends with a slash. Your service can expose it through a reverse proxy that handles authentication or access links. The browser app uses relative paths, so it works under a path prefix, as long as the public URL also ends with a slash. Your service is responsible for public authentication, routing, retention, and recovery.

The HTTP server has no authentication. The default loopback address suits a proxy on the same machine. Set a non-loopback `host` only inside a trusted network; otherwise keep it on loopback behind a protected proxy.

Always call `close()` when the review should no longer be available. It cancels the review if needed, closes the review agent context, and stops the HTTP server.

In the UI, finishing a review first shows what will be returned, including the full Markdown. Comments are always returned. Conversations with the review agent are returned as context only if the reviewer includes them. With neither, finishing approves the change. The returned Markdown stands on its own: it names the reviewed scope, quotes the guide content each guide comment refers to, and marks included conversations as context.

`result` resolves once, with the outcome or the reason for cancellation. An approval and a review with comments are separate outcomes, so you never need to check for placeholder text:

```ts
const result = await review.result;
if (result.status === "returned" && result.outcome === "approved") {
  console.log("approved without comments");
} else if (result.status === "returned") {
  console.log(result.review);
}
```

## Durable review state

By default, comments, conversation transcripts, guide content, and UI preferences are kept only in memory. Pass a `storage` adapter to save them:

```ts
const review = await startTauSdkDiffReview({
  session,
  source: { kind: "git_diff", diffArgs: ["main...HEAD"] },
  storage: {
    load: () => database.loadReviewState(reviewId),
    save: (document) => database.saveReviewState(reviewId, document),
  },
});
```

The stored document is a versioned Tau value of limited size. Store it as is, without reading or changing it. Tau saves each change before the HTTP request succeeds, and undoes the change if saving fails.

To restore, the stored document must be valid, supported by the running Tau version, and made for the same diff. "The same diff" covers the patch, file metadata, diff command and arguments, repository root, and working directory. If the state is invalid, unsupported, or for a different diff, `startTauSdkDiffReview()` rejects, instead of quietly starting empty. Your application then decides whether to keep, discard, or replace the document before trying again.

Saved state does not include loading indicators or review agent thread IDs. After a restore, the first follow-up question starts a new agent thread and gives it the saved conversation transcript.

## Durable submission

Use `onSubmit` when the submitted review must be saved before the browser is told it succeeded:

```ts
const review = await startTauSdkDiffReview({
  session,
  source: { kind: "git_diff", diffArgs: ["main...HEAD"] },
  storage,
  onSubmit: async (submission) => {
    await database.acceptReviewOnce({
      reviewId,
      ...submission,
    });
  },
});
```

An approved submission has `outcome: "approved"` and no `review` field. A commented submission has `outcome: "commented"` and a required `review` field. Both include `diffCommand` and `reviewedFiles`.

Each running review server allows only one submission at a time, and none after one succeeds. Tau waits for `onSubmit` to finish before reporting success and closing the review. If the callback fails, the reviewer can submit again.

Your application is responsible for recording the submission exactly once, for deciding whether a submitted review may be opened again, and for keeping or deleting stored state. A typical callback marks its own review record as submitted and queues follow-up work in one transaction.
