import type { Api, Model } from "@mariozechner/pi-ai";
import { parseModelReasoningTarget, type ResolvedModelTarget } from "../model_target.js";
import type { SubagentLaunchModel } from "./types.js";

export type LaunchModelResolver = (provider: string, modelId: string) => Model<Api> | undefined;

function toSubagentLaunchModel(target: ResolvedModelTarget): SubagentLaunchModel {
  return {
    model: target.model,
    reasoning: target.reasoning,
    normalized: target.normalized,
  };
}

export function parseSubagentLaunchModel(
  value: string,
  options: { resolveModel: LaunchModelResolver },
): {
  launchModel?: SubagentLaunchModel;
  error?: string;
} {
  const parsed = parseModelReasoningTarget(value, options);
  if (!parsed.target) {
    return { error: parsed.error };
  }

  return {
    launchModel: toSubagentLaunchModel(parsed.target),
  };
}

export function parseSubagentLaunchModelList(
  raw: unknown,
  options: { resolveModel: LaunchModelResolver },
): {
  launchModels?: string[];
  error?: string;
} {
  if (raw === undefined) {
    return {};
  }

  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    return { error: "must be a list of strings" };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const parsed = parseSubagentLaunchModel(entry, options);
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
