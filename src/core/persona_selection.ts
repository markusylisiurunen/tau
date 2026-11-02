import {
  MIN_AUTO_COMPACT_THRESHOLD_TOKENS,
  type SessionProtocolPersonaOverrides,
} from "../protocol/session_protocol.js";
import { parsePersonaString } from "./cli.js";
import type { Persona } from "./types.js";

export class PersonaSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaSelectionError";
  }
}

export function resolvePersonaSelection(
  personas: Persona[],
  defaultPersona: string | undefined,
  personaId: string | null,
  overrides: SessionProtocolPersonaOverrides = {},
): Persona {
  if (
    personaId === null &&
    (overrides.reasoning !== undefined || overrides.autoCompactThresholdTokens !== undefined)
  ) {
    throw new PersonaSelectionError("workspace selection does not accept overrides");
  }
  if (
    overrides.autoCompactThresholdTokens !== undefined &&
    (!Number.isSafeInteger(overrides.autoCompactThresholdTokens) ||
      overrides.autoCompactThresholdTokens < MIN_AUTO_COMPACT_THRESHOLD_TOKENS)
  ) {
    throw new PersonaSelectionError("invalid automatic compaction threshold");
  }
  const reference =
    personaId === null && defaultPersona ? parsePersonaString(defaultPersona, personas) : undefined;
  const id = personaId ?? reference?.personaId ?? personas[0]?.id;
  const persona = personas.find((candidate) => candidate.id === id);
  if (!persona) {
    throw new PersonaSelectionError(`persona '${id}' is not available`);
  }
  const selected = structuredClone(persona);
  const reasoning = overrides.reasoning ?? reference?.reasoning;
  if (reasoning !== undefined) {
    if (
      overrides.reasoning !== undefined &&
      ((!persona.model.reasoning && reasoning !== "none") ||
        (persona.allowedReasoningLevels?.length &&
          !persona.allowedReasoningLevels.includes(reasoning)))
    ) {
      throw new PersonaSelectionError(
        `reasoning effort '${reasoning}' is not supported by persona '${persona.id}'`,
      );
    }
    selected.settings.reasoning = reasoning;
  }
  return selected;
}
