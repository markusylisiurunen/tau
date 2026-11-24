import { type LoadedModelResolver, loadModelResolver } from "../models/catalog.js";
import type { RemoteModelCatalogSnapshot } from "../models/remote_catalog.js";
import { parsePersonaReference } from "../persona_reference.js";
import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import { loadAllContent } from "./content_loader.js";
import type { ConfigDeps } from "./deps.js";
import {
  type ClientConfig,
  type HostConfig,
  type SessionConfig,
  toClientConfig,
  toHostConfig,
  toSessionConfig,
} from "./ownership.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import { loadConfigWithDiagnostics } from "./schema.js";
import type { ThemeDefinition } from "./theme_variants.js";
import { buildVirtualBundle, type VirtualBundle } from "./virtual_bundle.js";

export interface RuntimeBootstrap {
  host: HostConfig;
  client: ClientConfig;
  session: SessionConfig;
  levels: ConfigLevel[];
  modelResolver: LoadedModelResolver;
  virtualBundle: VirtualBundle;
  warnings: string[];
}

export interface RuntimeConfigResult {
  bootstrap: RuntimeBootstrap;
  config: SessionConfig;
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
  warnings: string[];
}

/** What a session may learn from its execution environment. Host and client settings stay out. */
export type SessionRuntimeConfigResult = Omit<RuntimeConfigResult, "bootstrap" | "themes"> & {
  bootstrap: Pick<RuntimeBootstrap, "modelResolver">;
};

export function loadRuntimeBootstrap(
  cwd: string,
  deps: ConfigDeps,
  options: { remoteCatalog?: RemoteModelCatalogSnapshot } = {},
): RuntimeBootstrap {
  const levels = resolveConfigLevels(deps, { cwd });
  const modelResolver = loadModelResolver({ remoteCatalog: options.remoteCatalog });
  const configResult = loadConfigWithDiagnostics(deps, {
    levels,
    modelResolver,
  });
  const virtualBundle = buildVirtualBundle(modelResolver.resolveConfiguredModel);

  return {
    host: toHostConfig(configResult.config),
    client: toClientConfig(configResult.config, configResult.personalSpeechVocabulary),
    session: toSessionConfig(configResult.config),
    levels,
    modelResolver,
    virtualBundle,
    warnings: configResult.errors,
  };
}

export function toSessionRuntimeConfig(result: RuntimeConfigResult): SessionRuntimeConfigResult {
  return {
    bootstrap: { modelResolver: result.bootstrap.modelResolver },
    config: result.config,
    personas: result.personas,
    prompts: result.prompts,
    skills: result.skills,
    warnings: result.warnings,
  };
}

export async function loadRuntimeConfig(
  cwd: string,
  deps: ConfigDeps,
  options: { remoteCatalog?: RemoteModelCatalogSnapshot } = {},
): Promise<RuntimeConfigResult> {
  const bootstrap = loadRuntimeBootstrap(cwd, deps, options);
  const content = await loadAllContent(bootstrap.session, {
    deps,
    levels: bootstrap.levels,
    modelResolver: bootstrap.modelResolver.resolveModel,
    virtualBundle: bootstrap.virtualBundle,
  });
  const warnings = [...bootstrap.warnings, ...content.errors];
  if (bootstrap.session.defaultPersona) {
    const parsedDefaultPersona = parsePersonaReference(bootstrap.session.defaultPersona);
    const personaId = parsedDefaultPersona.personaId;
    const matched = personaId
      ? content.personas.some((persona) => persona.id === personaId)
      : false;
    if (!matched) {
      warnings.push(
        `defaultPersona '${bootstrap.session.defaultPersona}' not found in loaded personas.`,
      );
    }
  }
  if (bootstrap.client.defaultTheme) {
    const matched = content.themes.some((theme) => theme.id === bootstrap.client.defaultTheme);
    if (!matched) {
      warnings.push(
        `defaultTheme '${bootstrap.client.defaultTheme}' not found in built-in themes.`,
      );
    }
  }

  return {
    bootstrap,
    config: bootstrap.session,
    personas: content.personas,
    prompts: content.prompts,
    skills: content.skills,
    themes: content.themes,
    warnings,
  };
}
