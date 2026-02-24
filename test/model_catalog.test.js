import { describe, expect, it } from "vitest";
import { listModels, listProviders, resolveModel } from "../dist/core/models/catalog.js";

describe("model catalog", () => {
  it("loads pi-ai providers and models", () => {
    const providers = listProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");

    const openaiModels = listModels("openai");
    expect(openaiModels.some((model) => model.id === "gpt-5.2")).toBe(true);

    const model = resolveModel("openai", "gpt-5.2");
    expect(model).toBeTruthy();
    expect(model.provider).toBe("openai");
    expect(model.id).toBe("gpt-5.2");
  });

  it("returns no models for unknown providers", () => {
    expect(listModels("missing-provider")).toEqual([]);
    expect(resolveModel("missing-provider", "missing-model")).toBeUndefined();
  });
});
