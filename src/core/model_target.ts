import type { Api, Model } from "@mariozechner/pi-ai";
import { listProviders } from "./models/catalog.js";
import { REASONING_LEVELS, type ReasoningEffort, ReasoningEffortSchema } from "./types.js";

export type ModelTargetResolver = (provider: string, modelId: string) => Model<Api> | undefined;

export type ResolvedModelTarget = {
  model: Model<Api>;
  reasoning: ReasoningEffort;
  normalized: string;
};

function parseProvider(raw: string): string | undefined {
  const provider = raw.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }

  if (!listProviders().includes(provider)) {
    return undefined;
  }

  return provider;
}

export function parseModelReasoningTarget(
  value: string,
  options: { resolveModel: ModelTargetResolver },
): {
  target?: ResolvedModelTarget;
  error?: string;
} {
  const raw = value.trim();
  if (!raw) {
    return { error: "must be a non-empty string in format <provider>/<model>:<effort>" };
  }

  const effortSeparator = raw.lastIndexOf(":");
  if (effortSeparator <= 0 || effortSeparator >= raw.length - 1) {
    return { error: "must use format <provider>/<model>:<effort>" };
  }

  const modelPart = raw.slice(0, effortSeparator).trim();
  const effortPart = raw
    .slice(effortSeparator + 1)
    .trim()
    .toLowerCase();

  const providerSeparator = modelPart.indexOf("/");
  if (providerSeparator <= 0 || providerSeparator >= modelPart.length - 1) {
    return { error: "must use format <provider>/<model>:<effort>" };
  }

  const providerPart = modelPart.slice(0, providerSeparator);
  const modelIdPart = modelPart.slice(providerSeparator + 1).trim();

  if (!modelIdPart) {
    return { error: "model id is required" };
  }

  const provider = parseProvider(providerPart);
  if (!provider) {
    return { error: `unknown provider '${providerPart.trim()}'` };
  }

  const model = options.resolveModel(provider, modelIdPart);
  if (!model) {
    return { error: `unknown model '${provider}/${modelIdPart}'` };
  }

  const reasoning = ReasoningEffortSchema.safeParse(effortPart);
  if (!reasoning.success) {
    return {
      error: `invalid reasoning effort. expected one of: ${REASONING_LEVELS.join(", ")}`,
    };
  }

  return {
    target: {
      model,
      reasoning: reasoning.data,
      normalized: `${provider}/${model.id}:${reasoning.data}`,
    },
  };
}
