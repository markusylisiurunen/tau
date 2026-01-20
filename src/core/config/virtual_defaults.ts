import { personas as builtinPersonas } from "../personas.js";
import type { Config } from "./schema.js";

export function getVirtualConfigDefaults(): Config {
  const defaults: Config = {
    defaultRisk: "read-only",
    defaultTheme: "gold",
  };

  const defaultPersonaId = builtinPersonas[0]?.id;
  if (defaultPersonaId) {
    defaults.defaultPersona = defaultPersonaId;
  }

  return defaults;
}
