import { describe, expect, it } from "vitest";
import { rankBm25 } from "../dist/core/utils/bm25.js";

const documents = (texts) => texts.map((text, index) => ({ id: String(index), text }));

describe("BM25 ranking", () => {
  it("splits identifiers and normalizes case and plurals", () => {
    const docs = documents(["listGitHubIssues", "search_documents", "unrelated"]);
    expect(rankBm25("github issue", docs, 8).map((match) => match.id)).toEqual(["0"]);
    expect(rankBm25("SEARCH document", docs, 8).map((match) => match.id)).toEqual(["1"]);
  });

  it("uses BM25 frequency saturation and length normalization", () => {
    const matches = rankBm25("issue", documents(["issue", "issue issue"]), 8);
    const idf = Math.log(1 + 0.5 / 2.5);
    expect(matches[0].id).toBe("1");
    expect(matches[0].score).toBeCloseTo(idf * (4.4 / 3.5));
    expect(matches[1].score).toBeCloseTo(idf * (2.2 / 1.9));
  });

  it("keeps ties stable, deduplicates query terms, and limits positive matches", () => {
    const docs = documents(["issue", "issue", "document"]);
    expect(rankBm25("issue issue", docs, 8)).toEqual(rankBm25("issue", docs, 8));
    expect(rankBm25("issue", docs, 1).map((match) => match.id)).toEqual(["0"]);
    expect(rankBm25("issue", docs, 8).map((match) => match.id)).toEqual(["0", "1"]);
    expect(rankBm25("the and with", docs, 8)).toEqual([]);
    expect(rankBm25("unknown", docs, 8)).toEqual([]);
    expect(rankBm25("issue", [], 8)).toEqual([]);
    expect(rankBm25("issue", docs, 0)).toEqual([]);
  });
});
