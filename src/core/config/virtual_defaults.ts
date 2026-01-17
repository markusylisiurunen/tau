import type { Config } from "./schema.js";

const DEFAULT_PERSONA_ID = "opus-4.5";

export function getVirtualConfigDefaults(): Config {
  return {
    defaultPersona: DEFAULT_PERSONA_ID,
    defaultRisk: "read-only",
  };
}
