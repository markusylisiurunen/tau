import { personas as builtinPersonas } from "../personas.js";
import type { Config } from "./schema.js";

const DEFAULT_PERSONA_ID = builtinPersonas[0]?.id;

export function getVirtualConfigDefaults(): Config {
  const defaults: Config = {
    defaultRisk: "read-only",
  };

  if (DEFAULT_PERSONA_ID) {
    defaults.defaultPersona = DEFAULT_PERSONA_ID;
  }

  return defaults;
}
