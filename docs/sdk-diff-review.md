# SDK browser diff review

`startTauSdkDiffReview()` starts Tau's built-in browser review UI for an observed SDK session without requiring the TUI or opening a browser. It captures the selected diff through the session execution environment, creates the same review-scoped ephemeral agent context used by `/diff`, eagerly prepares shared review context and the reviewer guide, and binds an HTTP server on loopback by default.

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

The source may instead be `{ kind: "patch_files", patchFiles, scopeLabel }`. Paths and Git arguments belong to the session execution environment. Captured snapshot patches are limited to 16 MiB; narrow the Git arguments or patch-file selection when a larger scope is rejected. A plain working-tree snapshot includes non-binary untracked files up to 4 MiB each within that aggregate limit. Optional `host`, `port`, and `signal` fields control the client-owned HTTP process and startup cancellation.

## Routing and lifecycle

The returned `url` is local to the SDK client machine and ends with a trailing slash. An embedding service may expose it through an authenticated or capability-protected reverse proxy. The browser app uses paths relative to its document URL, so it can be mounted below a route prefix; the external route URL must also end with a trailing slash. The embedding service owns public authentication, routing, retention, and recovery.

The HTTP server does not provide authentication. The default loopback listener is suitable for a same-machine proxy. An explicitly configured non-loopback `host` is safe only within a trusted network boundary; otherwise, keep the listener on loopback and expose it through a protected proxy.

Always call `close()` when the review is no longer available. This cancels the review if needed, closes the ephemeral agent context, and stops the HTTP server. `result` resolves once with the returned outcome or cancellation reason. Returned results distinguish an approval from submitted comments without sentinel review text:

```ts
const result = await review.result;
if (result.status === "returned" && result.outcome === "approved") {
  console.log("approved without comments");
} else if (result.status === "returned") {
  console.log(result.review);
}
```

## Durable review state

Review annotations, transcripts, guide content and comments, and UI preferences are in memory by default. Supply a client-owned `storage` adapter to preserve them:

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

The stored document is an opaque, size-bounded, versioned Tau value. The embedding application should store it without inspecting or modifying it. Tau persists durable mutations before returning HTTP success and rolls a mutation back if storage fails.

Restoration requires the stored document to be valid, supported by the running Tau version, and bound to the same captured diff. The binding includes the patch, file metadata, diff command and arguments, repository root, and working directory. Invalid, unsupported, or mismatched state causes `startTauSdkDiffReview()` to reject instead of silently starting with empty state. The embedding application must decide whether to retain the failed document or discard or replace it before retrying startup.

Durable review state excludes loading indicators and ephemeral agent thread identifiers. After restoration, the first follow-up recreates an agent thread from a fresh bootstrap and supplies the stored conversation transcript.

## Durable submission

Use `onSubmit` when review acceptance must be durable before the browser sees success:

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

Tau permits only one in-flight or successful submission per running diff-review server. It awaits `onSubmit` before returning HTTP success and closing the review. If the callback fails, the submission remains available for retry.

The embedding application remains responsible for a durable exactly-once transition, deciding whether a submitted review may be reconstructed, and retaining or removing stored state. A typical acceptance callback atomically marks its own review record submitted and enqueues downstream work.
