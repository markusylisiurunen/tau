import type { ModelResolver } from "../models/catalog.js";
import { createBuiltinPersonas } from "../personas.js";
import type { Persona } from "../types.js";
import { builtinThemes } from "./builtin_themes.js";
import type { Config } from "./schema.js";
import type { ThemeDefinition } from "./theme_variants.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export type VirtualBundle = {
  config: Config;
  builtinPersonas: Persona[];
  personas: Persona[];
  themes: ThemeDefinition[];
};

export function buildVirtualBundle(config: Config, modelResolver?: ModelResolver): VirtualBundle {
  const includeBuiltinPersonas = !config.disableBuiltinPersonas;
  const builtinPersonas = createBuiltinPersonas(modelResolver);

  return {
    config: getVirtualConfigDefaults(),
    builtinPersonas,
    personas: includeBuiltinPersonas ? builtinPersonas : [],
    themes: builtinThemes,
  };
}
