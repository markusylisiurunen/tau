import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import type { BashCommand } from "./bash_commands.js";
import type { ThemeDefinition } from "./content_loader.js";
import { loadAllContent } from "./content_loader.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import type { Config } from "./schema.js";
import { loadConfigWithDiagnostics } from "./schema.js";

export interface RuntimeConfigResult {
  config: Config;
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
  bashCommands: BashCommand[];
  warnings: string[];
}

export async function loadRuntimeConfig(
  cwd: string,
  deps?: ConfigDeps,
): Promise<RuntimeConfigResult> {
  const resolvedDeps = deps ?? createDefaultConfigDeps();
  const configResult = loadConfigWithDiagnostics(cwd, resolvedDeps);
  const config = configResult.config;
  const content = await loadAllContent(config, { cwd, deps: resolvedDeps });
  const warnings = [...configResult.errors, ...content.errors];
  if (config.defaultPersona) {
    const raw = config.defaultPersona.trim();
    if (raw) {
      const personaValue = raw.split(":")[0]?.trim();
      if (personaValue) {
        const matched = content.personas.some(
          (persona) => persona.id.toLowerCase() === personaValue.toLowerCase(),
        );
        if (!matched) {
          warnings.push(`defaultPersona '${config.defaultPersona}' not found in loaded personas.`);
        }
      }
    }
  }
  if (config.defaultTheme) {
    const themeId = config.defaultTheme.toLowerCase();
    const matched = content.themes.some((theme) => theme.id.toLowerCase() === themeId);
    if (!matched) {
      warnings.push(
        `defaultTheme '${config.defaultTheme}' not found in .tau/themes or ~/.config/tau/themes.`,
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
    warnings,
  };
}
