import type { ModelResolver } from "../models/catalog.js";
import { createBuiltinPersonas } from "../personas.js";
import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import { builtinThemes } from "./builtin_themes.js";
import type { ThemeDefinition } from "./content_loader.js";
import type { Config } from "./schema.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export type VirtualBundle = {
  config: Config;
  builtinPersonas: Persona[];
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
};

export function buildVirtualBundle(config: Config, modelResolver?: ModelResolver): VirtualBundle {
  const includeBuiltinPersonas = !config.disableBuiltinPersonas;
  const includeBuiltinThemes = !config.disableBuiltinThemes;
  const builtinPersonas = createBuiltinPersonas(modelResolver);

  return {
    config: getVirtualConfigDefaults(),
    builtinPersonas,
    personas: includeBuiltinPersonas ? builtinPersonas : [],
    prompts: [],
    skills: [],
    themes: includeBuiltinThemes ? builtinThemes : [],
  };
}
