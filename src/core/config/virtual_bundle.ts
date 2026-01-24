import { personas as builtinPersonas } from "../personas.js";
import type { PromptTemplate } from "../prompts.js";
import { prompts as builtinPrompts } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import { builtinThemes } from "./builtin_themes.js";
import type { ThemeDefinition } from "./content_loader.js";
import type { ConfigDeps } from "./deps.js";
import type { Config } from "./schema.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export type VirtualBundle = {
  config: Config;
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
};

export function buildVirtualBundle(config: Config, _deps?: ConfigDeps): VirtualBundle {
  const includeBuiltinPersonas = !config.disableBuiltinPersonas;
  const includeBuiltinPrompts = !config.disableBuiltinPrompts;
  const includeBuiltinThemes = !config.disableBuiltinThemes;
  const basePersonas = builtinPersonas;

  return {
    config: getVirtualConfigDefaults(),
    personas: includeBuiltinPersonas ? basePersonas : [],
    prompts: includeBuiltinPrompts ? builtinPrompts : [],
    skills: [],
    themes: includeBuiltinThemes ? builtinThemes : [],
  };
}
