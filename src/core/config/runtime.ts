import { loadModelResolver } from "../models/catalog.js";
import { parsePersonaReference } from "../persona_reference.js";
import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import type { BashCommand } from "./bash_commands.js";
import type { ThemeDefinition } from "./content_loader.js";
import { loadAllContent } from "./content_loader.js";
import type { ConfigDeps } from "./deps.js";
import type { DiffToolConfig } from "./diff_tool.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { loadConfigWithDiagnostics } from "./schema.js";

export interface RuntimeConfigResult {
  config: Config;
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
  bashCommands: BashCommand[];
  diffTool?: DiffToolConfig;
  warnings: string[];
}

export async function loadRuntimeConfig(
  cwd: string,
  deps: ConfigDeps,
): Promise<RuntimeConfigResult> {
  const levels = resolveConfigLevels(deps, { cwd });
  const modelResolverResult = loadModelResolver({ deps, levels });
  const configResult = loadConfigWithDiagnostics(deps, {
    levels,
    modelResolver: modelResolverResult,
  });
  const config = configResult.config;
  const content = await loadAllContent(config, {
    deps,
    levels,
    modelResolver: modelResolverResult,
  });
  const warnings = [...configResult.errors, ...content.errors];
  if (config.defaultPersona) {
    const parsedDefaultPersona = parsePersonaReference(config.defaultPersona);
    const personaId = parsedDefaultPersona.personaId;
    const matched = personaId
      ? content.personas.some((persona) => persona.id === personaId)
      : false;
    if (!matched) {
      warnings.push(`defaultPersona '${config.defaultPersona}' not found in loaded personas.`);
    }
  }
  if (config.defaultTheme) {
    const matched = content.themes.some((theme) => theme.id === config.defaultTheme);
    if (!matched) {
      warnings.push(
        `defaultTheme '${config.defaultTheme}' not found in built-in themes, .tau/themes, or ~/.config/tau/themes.`,
      );
    }
  }

  return {
    config,
    personas: content.personas,
    prompts: content.prompts,
    skills: content.skills,
    themes: content.themes,
    bashCommands: config.bashCommands ?? [],
    diffTool: config.diffTool,
    warnings,
  };
}
