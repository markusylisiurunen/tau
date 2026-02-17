import type { SandboxConfig } from "../config/index.js";
import type { Persona, Skill } from "../types.js";
import { resolveAgentCwd } from "../utils/agent_environment.js";
import { findAgentsFilesInScopeDetailed } from "../utils/agents_files.js";
import { buildProjectContextBlock, buildSkillsIndexBlock } from "../utils/context_builder.js";
import type { ChatRuntimePromptContext } from "./chat_runtime.js";

export type ResolvedPersonaSkills = {
  skills: Skill[];
  unknown: string[];
  skillsBlock?: string;
};

export function resolvePersonaSkillsForPromptContext(args: {
  persona: Persona;
  discoveredSkills: Skill[];
}): ResolvedPersonaSkills {
  const personaSkills = args.persona.skills;
  if (personaSkills === "*") {
    const skills = [...args.discoveredSkills];
    return {
      skills,
      unknown: [],
      skillsBlock: buildSkillsIndexBlock(skills),
    };
  }

  if (!personaSkills || personaSkills.length === 0) {
    return { skills: [], unknown: [], skillsBlock: undefined };
  }

  const skillsByName = new Map<string, Skill>();
  for (const skill of args.discoveredSkills) {
    skillsByName.set(skill.name.toLowerCase(), skill);
  }

  const skills: Skill[] = [];
  const unknown: string[] = [];

  for (const name of personaSkills) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const skill = skillsByName.get(trimmed.toLowerCase());
    if (skill) {
      skills.push(skill);
      continue;
    }
    unknown.push(trimmed);
  }

  return {
    skills,
    unknown,
    skillsBlock: buildSkillsIndexBlock(skills),
  };
}

export type ResolvedProjectContext = {
  agentsFiles: string[];
  warnings: string[];
  projectContextBlock?: string;
};

export function resolveProjectContextForPromptContext(args: {
  cwd: string;
  home: string;
  includeAgentContext: boolean;
  readFile: (path: string) => string;
}): ResolvedProjectContext {
  if (!args.includeAgentContext) {
    return { agentsFiles: [], warnings: [], projectContextBlock: undefined };
  }

  const agentsContext = findAgentsFilesInScopeDetailed(args.cwd, args.home);

  return {
    agentsFiles: agentsContext.files,
    warnings: agentsContext.errors,
    projectContextBlock: buildProjectContextBlock({
      cwd: args.cwd,
      home: args.home,
      agentsFiles: agentsContext.files,
      readFile: args.readFile,
    }),
  };
}

export type ResolveRuntimePromptBootstrapArgs = {
  persona: Persona;
  discoveredSkills: Skill[];
  cwd: string;
  home: string;
  includeAgentContext: boolean;
  sandboxEnabled: boolean;
  sandboxConfig?: SandboxConfig;
  sandboxEnvironmentInfo?: string;
  readFile: (path: string) => string;
};

export type RuntimePromptBootstrap = {
  promptContext: ChatRuntimePromptContext;
  agentsFiles: string[];
  warnings: string[];
  unknownSkills: string[];
};

export function resolveRuntimePromptBootstrap(
  args: ResolveRuntimePromptBootstrapArgs,
): RuntimePromptBootstrap {
  const projectContext = resolveProjectContextForPromptContext({
    cwd: args.cwd,
    home: args.home,
    includeAgentContext: args.includeAgentContext,
    readFile: args.readFile,
  });
  const resolvedSkills = resolvePersonaSkillsForPromptContext({
    persona: args.persona,
    discoveredSkills: args.discoveredSkills,
  });

  return {
    promptContext: {
      cwd: resolveAgentCwd({
        cwd: args.cwd,
        sandboxEnabled: args.sandboxEnabled,
        sandboxConfig: args.sandboxConfig,
      }),
      hostCwd: args.cwd,
      home: args.home,
      includeAgentContext: args.includeAgentContext,
      projectContextBlock: projectContext.projectContextBlock,
      sandboxEnabled: args.sandboxEnabled,
      sandboxEnvironmentInfo: args.sandboxEnvironmentInfo,
      skillsBlock: resolvedSkills.skillsBlock,
    },
    agentsFiles: projectContext.agentsFiles,
    warnings: projectContext.warnings,
    unknownSkills: resolvedSkills.unknown,
  };
}
