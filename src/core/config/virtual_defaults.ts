import { DEFAULT_BUILTIN_PERSONA_ID } from "../personas.js";
import { type Config, DEFAULT_AUTO_COMPACT_CONFIG } from "./schema.js";

export function getVirtualConfigDefaults(): Config {
  return {
    defaultPersona: DEFAULT_BUILTIN_PERSONA_ID,
    defaultTheme: "gold",
    autoCompact: { ...DEFAULT_AUTO_COMPACT_CONFIG },
  };
}
