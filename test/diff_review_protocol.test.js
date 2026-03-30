import { describe, expect, it } from "vitest";
import {
  createDiffReviewErrorResponse,
  createDiffReviewSuccessResponse,
  DIFF_REVIEW_ERROR_CODES,
  DIFF_REVIEW_METHODS,
  DIFF_REVIEW_PROTOCOL_VERSION,
  parseDiffReviewRequestLine,
  serializeDiffReviewMessage,
  validateDiffReviewParams,
} from "../src/core/diff_review/protocol.ts";

describe("diff_review protocol", () => {
  it("parses valid request lines", () => {
    const parsed = parseDiffReviewRequestLine(
      JSON.stringify({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "thread.submit_message",
        params: { message: "Review this file" },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "thread.submit_message",
        params: { message: "Review this file" },
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
          params: { review: "" },
        }),
      ),
    ).toEqual({
      ok: false,
      id: 2,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });
  });

  it("validates per-method params", () => {
    expect(validateDiffReviewParams("initialize", { token: "secret" })).toEqual({
      ok: true,
      value: { token: "secret" },
    });

    expect(validateDiffReviewParams("session.get_context", {})).toEqual({
      ok: true,
      value: {},
    });

    expect(validateDiffReviewParams("session.get_diff", { path: "src/a.ts" })).toEqual({
      ok: true,
      value: { path: "src/a.ts" },
    });

    expect(validateDiffReviewParams("session.get_diff", { path: " src/a.ts " })).toEqual({
      ok: true,
      value: { path: " src/a.ts " },
    });

    expect(validateDiffReviewParams("session.set_ui_text", { text: "ready" })).toEqual({
      ok: true,
      value: { text: "ready" },
    });

    expect(
      validateDiffReviewParams("thread.submit_message", { threadId: "", message: "hi" }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });
  });

  it("serializes success and error responses", () => {
    const success = createDiffReviewSuccessResponse("req-1", {
      protocolVersion: DIFF_REVIEW_PROTOCOL_VERSION,
      sessionId: "session-1",
      methods: [...DIFF_REVIEW_METHODS],
      alreadyInitialized: false,
    });
    const failure = createDiffReviewErrorResponse(
      "req-2",
      DIFF_REVIEW_ERROR_CODES.unauthorized,
      "bad token",
    );

    expect(JSON.parse(serializeDiffReviewMessage(success))).toEqual(success);
    expect(JSON.parse(serializeDiffReviewMessage(failure))).toEqual(failure);
  });
});
