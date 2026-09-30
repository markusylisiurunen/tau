import type { ModelResolver } from "../models/catalog.js";
import { createBuiltinPersonas } from "../personas.js";
import type { Persona } from "../types.js";
import { builtinThemes } from "./builtin_themes.js";
import type { Config } from "./schema.js";
import type { ThemeDefinition } from "./theme_variants.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export type VirtualBundle = {
  config: Config;
  personas: Persona[];
  themes: ThemeDefinition[];
};

export function buildVirtualBundle(modelResolver?: ModelResolver): VirtualBundle {
  return {
    config: getVirtualConfigDefaults(),
    personas: createBuiltinPersonas(modelResolver),
    themes: builtinThemes,
  };
}
