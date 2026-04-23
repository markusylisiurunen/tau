import { type LoadedModelResolver, loadModelResolver } from "../models/catalog.js";
import { parsePersonaReference } from "../persona_reference.js";
import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import type { BashCommand } from "./bash_commands.js";
import type { ThemeDefinition } from "./content_loader.js";
import { loadAllContent } from "./content_loader.js";
import type { ConfigDeps } from "./deps.js";
import type { DiffToolConfig } from "./diff_tool.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { loadConfigWithDiagnostics } from "./schema.js";
import { buildVirtualBundle, type VirtualBundle } from "./virtual_bundle.js";

export interface RuntimeBootstrap {
  config: Config;
  levels: ConfigLevel[];
  modelResolver: LoadedModelResolver;
  virtualBundle: VirtualBundle;
  warnings: string[];
}

export interface RuntimeConfigResult {
  bootstrap: RuntimeBootstrap;
  config: Config;
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
  bashCommands: BashCommand[];
  diffTool?: DiffToolConfig;
  warnings: string[];
}

export function loadRuntimeBootstrap(cwd: string, deps: ConfigDeps): RuntimeBootstrap {
  const levels = resolveConfigLevels(deps, { cwd });
  const modelResolver = loadModelResolver({ deps, levels });
  const configResult = loadConfigWithDiagnostics(deps, {
    levels,
    modelResolver,
  });
  const config = configResult.config;
  const virtualBundle = buildVirtualBundle(config, modelResolver.resolveConfiguredModel);

  return {
    config,
    levels,
    modelResolver,
    virtualBundle,
    warnings: configResult.errors,
  };
}

export async function loadRuntimeConfig(
  cwd: string,
  deps: ConfigDeps,
): Promise<RuntimeConfigResult> {
  const bootstrap = loadRuntimeBootstrap(cwd, deps);
  const content = await loadAllContent(bootstrap.config, {
    deps,
    levels: bootstrap.levels,
    modelResolver: bootstrap.modelResolver,
  });
  const warnings = [...bootstrap.warnings, ...content.errors];
  if (bootstrap.config.defaultPersona) {
    const parsedDefaultPersona = parsePersonaReference(bootstrap.config.defaultPersona);
    const personaId = parsedDefaultPersona.personaId;
    const matched = personaId
      ? content.personas.some((persona) => persona.id === personaId)
      : false;
    if (!matched) {
      warnings.push(
        `defaultPersona '${bootstrap.config.defaultPersona}' not found in loaded personas.`,
      );
    }
  }
  if (bootstrap.config.defaultTheme) {
    const matched = content.themes.some((theme) => theme.id === bootstrap.config.defaultTheme);
    if (!matched) {
      warnings.push(
        `defaultTheme '${bootstrap.config.defaultTheme}' not found in built-in themes, .tau/themes, or ~/.config/tau/themes.`,
      );
    }
  }

  return {
    bootstrap,
    config: bootstrap.config,
    personas: content.personas,
    prompts: content.prompts,
    skills: content.skills,
    themes: content.themes,
    bashCommands: bootstrap.config.bashCommands ?? [],
    diffTool: bootstrap.config.diffTool,
    warnings,
  };
}
