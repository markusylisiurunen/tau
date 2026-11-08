import { describe, expect, it } from "vitest";
import {
  DIFF_REVIEW_ERROR_CODES,
  DIFF_REVIEW_PROTOCOL_VERSION,
  parseDiffReviewRequestLine,
} from "../src/core/diff_review/protocol.ts";

describe("diff_review protocol", () => {
  it("parses valid request lines", () => {
    const parsed = parseDiffReviewRequestLine(
      JSON.stringify({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "thread.submit_message",
        params: {
          message: "Review this file",
          forkFromThreadId: "thread-0",
          reasoning: "medium",
        },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "thread.submit_message",
        params: {
          message: "Review this file",
          forkFromThreadId: "thread-0",
          reasoning: "medium",
        },
      },
    });
  });

  it("returns structured parse and validation errors", () => {
    expect(parseDiffReviewRequestLine("{bad-json}")).toEqual({
      ok: false,
      id: null,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.parseError }),
    });

    expect(
      parseDiffReviewRequestLine(
        JSON.stringify({
          version: DIFF_REVIEW_PROTOCOL_VERSION,
          type: "request",
          id: 1,
          method: "session.unknown",
          params: {},
        }),
      ),
    ).toEqual({
      ok: false,
      id: 1,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.methodNotFound }),
    });

    expect(
      parseDiffReviewRequestLine(
        JSON.stringify({
          version: DIFF_REVIEW_PROTOCOL_VERSION,
          type: "request",
          id: 2,
          method: "session.return_review",
          params: { outcome: "commented", review: "" },
        }),
      ),
    ).toEqual({
      ok: false,
      id: 2,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });
  });
});
