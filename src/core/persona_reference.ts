import { REASONING_LEVELS, type ReasoningEffort } from "./types.js";

export type PersonaReferenceParseError =
  | "empty-persona"
  | "missing-reasoning"
  | "invalid-reasoning";

export type ParsedPersonaReference = {
  personaId?: string;
  reasoning?: ReasoningEffort;
  rawReasoning?: string;
  error?: PersonaReferenceParseError;
};

export function parsePersonaReference(raw: string): ParsedPersonaReference {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "empty-persona" };
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return { personaId: trimmed };
  }

  const personaId = trimmed.slice(0, colonIndex).trim();
  const rawReasoning = trimmed.slice(colonIndex + 1).trim();

  if (!personaId) {
    return { error: "empty-persona" };
  }

  if (!rawReasoning) {
    return { personaId, error: "missing-reasoning" };
  }

  if (!(REASONING_LEVELS as string[]).includes(rawReasoning)) {
    return { personaId, rawReasoning, error: "invalid-reasoning" };
  }

  return { personaId, reasoning: rawReasoning as ReasoningEffort };
}

export function formatPersonaReference(args: {
  personaId: string;
  reasoning?: ReasoningEffort;
}): string {
  return args.reasoning ? `${args.personaId}:${args.reasoning}` : args.personaId;
}
