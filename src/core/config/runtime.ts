import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import type { BashCommand } from "./bash_commands.js";
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

  return {
    config,
    personas: content.personas,
    prompts: content.prompts,
    skills: content.skills,
    bashCommands: config.bashCommands ?? [],
    warnings,
  };
}
