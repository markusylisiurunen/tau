# SDK browser diff review

`startTauSdkDiffReview()` starts Tau's built-in browser review UI for an observed SDK session without requiring the TUI or opening a browser. It captures the selected diff through the session execution environment, creates the same read-only ephemeral review context used by `/diff`, eagerly warms its shared bootstrap thread, and binds an HTTP server on loopback by default.

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

The source may instead be `{ kind: "patch_files", patchFiles, scopeLabel }`. Paths and Git arguments belong to the session execution environment. Optional `host`, `port`, and `signal` fields control the client-owned HTTP process and startup cancellation.

## Routing and lifecycle

The returned `url` is local to the SDK client machine. An embedding service may expose it through an authenticated or capability-protected reverse proxy. The browser app uses paths relative to its document URL, so it can be mounted below a route prefix. The embedding service owns public authentication, routing, retention, and recovery.

Always call `close()` when the review is no longer available. This cancels the review if needed, closes the ephemeral agent context, and stops the HTTP server. `result` resolves once with the returned review or cancellation reason.

## Durable review state

Review annotations, transcripts, brief content, and UI preferences are in memory by default. Supply a client-owned `storage` adapter to preserve them:

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

The stored document is an opaque, size-bounded, versioned Tau value. The embedding application should store it without inspecting or modifying it. Tau persists durable mutations before returning HTTP success and rolls a mutation back if storage fails. It validates that restored state belongs to the same captured diff.

Durable review state excludes loading indicators and ephemeral agent thread identifiers. After restoration, the first follow-up recreates an agent thread from a fresh bootstrap and supplies the stored conversation transcript.

## Durable submission

Use `onSubmit` when review acceptance must be durable before the browser sees success:

```ts
const review = await startTauSdkDiffReview({
  session,
  source: { kind: "git_diff", diffArgs: ["main...HEAD"] },
  storage,
  onSubmit: async ({ review, diffCommand, reviewedFiles }) => {
    await database.acceptReviewOnce({
      reviewId,
      review,
      diffCommand,
      reviewedFiles,
    });
  },
});
```

Tau permits only one in-flight or successful submission per running diff-review server. It awaits `onSubmit` before returning HTTP success and closing the review. If the callback fails, the submission remains available for retry.

The embedding application remains responsible for a durable exactly-once transition, deciding whether a submitted review may be reconstructed, and retaining or removing stored state. A typical acceptance callback atomically marks its own review record submitted and enqueues downstream work.
