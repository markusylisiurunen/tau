import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { ReasoningEffortSchema } from "../types.js";
import type { SubagentLaunchModel } from "./types.js";

function parseProvider(raw: string): KnownProvider | undefined {
  const provider = raw.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }

  if (!getProviders().includes(provider as KnownProvider)) {
    return undefined;
  }

  return provider as KnownProvider;
}

function resolveModel(provider: KnownProvider, modelId: string): Model<Api> | undefined {
  return getModels(provider).find((candidate) => candidate.id === modelId);
}

export function parseSubagentLaunchModel(value: string): {
  launchModel?: SubagentLaunchModel;
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

  const model = resolveModel(provider, modelIdPart);
  if (!model) {
    return { error: `unknown model '${provider}/${modelIdPart}'` };
  }

  const reasoning = ReasoningEffortSchema.safeParse(effortPart);
  if (!reasoning.success) {
    return {
      error: "invalid reasoning effort. expected one of: none, minimal, low, medium, high, xhigh",
    };
  }

  const normalized = `${provider}/${model.id}:${reasoning.data}`;
  return {
    launchModel: {
      model,
      reasoning: reasoning.data,
      normalized,
    },
  };
}

export function parseSubagentLaunchModelList(raw: unknown): {
  launchModels?: string[];
  error?: string;
} {
  if (raw === undefined) {
    return {};
  }

  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
  if (!values) {
    return { error: "must be a string or list of strings" };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of values) {
    if (typeof entry !== "string") {
      return { error: "must be a string or list of strings" };
    }

    const parsed = parseSubagentLaunchModel(entry);
    if (parsed.error) {
      return { error: parsed.error };
    }

    const spec = parsed.launchModel;
    if (!spec || seen.has(spec.normalized)) {
      continue;
    }

    seen.add(spec.normalized);
    normalized.push(spec.normalized);
  }

  return { launchModels: normalized };
}
