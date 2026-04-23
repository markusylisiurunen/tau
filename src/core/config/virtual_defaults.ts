import { DEFAULT_BUILTIN_PERSONA_ID } from "../personas.js";
import type { Config } from "./schema.js";

export function getVirtualConfigDefaults(): Config {
  return {
    defaultPersona: DEFAULT_BUILTIN_PERSONA_ID,
    defaultRisk: "read-only",
    defaultTheme: "gold",
  };
}
