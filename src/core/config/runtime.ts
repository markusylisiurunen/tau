import { type LoadedModelResolver, loadModelResolver } from "../models/catalog.js";
import { parsePersonaReference } from "../persona_reference.js";
import type { PromptTemplate } from "../prompts.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { Persona, Skill } from "../types.js";
import { loadAllContent, parsePrompt, type ThemeDefinition } from "./content_loader.js";
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

type PromptTemplateCandidate = {
  path: string;
  content: string;
};

const COLLECT_PROMPT_TEMPLATE_CANDIDATES_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");

const cwd = path.resolve(process.argv[1]);
const home = path.resolve(process.argv[2]);
const promptId = String(process.argv[3] || "").toLowerCase();
const files = new Map();

function stat(pathname) {
  try {
    return fs.statSync(pathname);
  } catch {
    return undefined;
  }
}

function isDirectory(pathname) {
  return Boolean(stat(pathname)?.isDirectory());
}

function addPrompt(configDir) {
  const promptsDir = path.join(configDir, "prompts");
  if (!isDirectory(promptsDir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(promptsDir);
  } catch {
    return;
  }
  const fileName = entries.find((entry) => entry.toLowerCase() === promptId + ".md");
  if (!fileName) return;
  const filePath = path.join(promptsDir, fileName);
  const info = stat(filePath);
  if (!info?.isFile()) return;
  try {
    files.set(path.resolve(filePath), fs.readFileSync(filePath, "utf8"));
  } catch {}
}

const withinHome = cwd === home || cwd.startsWith(home + path.sep);
if (withinHome) {
  addPrompt(path.join(home, ".config", "tau"));
}

const stop = withinHome ? home : path.parse(cwd).root;
const roots = [];
let dir = cwd;
while (true) {
  if (isDirectory(path.join(dir, ".tau")) || isDirectory(path.join(dir, ".agents", "skills"))) {
    roots.push(dir);
  }
  if (dir === stop) break;
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
roots.reverse();
for (const root of roots) {
  addPrompt(path.join(root, ".tau"));
}

process.stdout.write(JSON.stringify({
  files: [...files.entries()].map(([filePath, content]) => ({ path: filePath, content }))
}));
`;

export async function resolvePromptTemplateWithBackend(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  home: string;
  promptId: string;
}): Promise<PromptTemplate | undefined> {
  const result = await options.backend.runNodeScript(
    COLLECT_PROMPT_TEMPLATE_CANDIDATES_SCRIPT,
    [options.cwd, options.home, options.promptId],
    { cwd: options.cwd, timeoutMs: 10_000, maxCaptureBytes: null },
  );
  if (result.exitCode !== 0) {
    const output = result.output.trim();
    throw new Error(
      output ? `failed to resolve prompt template: ${output}` : "failed to resolve prompt template",
    );
  }

  const candidates = parsePromptTemplateCandidates(result.output);
  let resolved: PromptTemplate | undefined;
  const requested = options.promptId.toLowerCase();
  for (const candidate of candidates) {
    const parsed = parsePrompt(candidate.path, candidate.content);
    if (parsed.prompt?.id.toLowerCase() === requested) {
      resolved = parsed.prompt;
    }
  }
  return resolved;
}

function parsePromptTemplateCandidates(output: string): PromptTemplateCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("execution environment returned invalid prompt template JSON", {
      cause: error,
    });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    throw new Error("execution environment returned invalid prompt template shape");
  }

  const files: PromptTemplateCandidate[] = [];
  for (const file of (parsed as { files: unknown[] }).files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof (file as PromptTemplateCandidate).path !== "string" ||
      typeof (file as PromptTemplateCandidate).content !== "string"
    ) {
      throw new Error("execution environment returned invalid prompt template file entry");
    }
    files.push({
      path: (file as PromptTemplateCandidate).path,
      content: (file as PromptTemplateCandidate).content,
    });
  }
  return files;
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
    diffTool: bootstrap.config.diffTool,
    warnings,
  };
}
