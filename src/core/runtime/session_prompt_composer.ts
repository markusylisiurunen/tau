import { buildSubagentSystemPrompt } from "../subagents/prompt.js";
import { formatSubagentsForPrompt } from "../subagents/registry.js";
import { TOOL_NAME_SPAWN_AGENT } from "../tools/tool_names.js";
import type { Persona } from "../types.js";
import { buildBaseSystemPrompt, buildEnvironmentTag } from "../utils/context.js";
export type ComposeSessionPromptsArgs = {
  persona: Persona;
  sessionId?: string;
  cwd: string;
  repoRoot?: string;
  repository?: string;
  sessionStartedAt: string;
  platform: NodeJS.Platform;
  skillsBlock?: string;
  projectContextBlock?: string;
};

export type SessionPromptComposition = {
  environmentTag: string;
  baseSystemPrompt: string;
  subagentSystemPrompt?: string;
};

export function composeSessionPrompts(args: ComposeSessionPromptsArgs): SessionPromptComposition {
  const environmentTag = buildEnvironmentTag({
    sessionId: args.sessionId,
    cwd: args.cwd,
    repoRoot: args.repoRoot,
    repository: args.repository,
    sessionStartedAt: args.sessionStartedAt,
    platform: args.platform,
  });

  const baseSystemPrompt = buildBaseSystemPrompt({
    personaSystemPrompt: args.persona.systemPrompt,
    skillsBlock: args.skillsBlock,
    projectContextBlock: args.projectContextBlock,
    environmentTag,
    subagentsBlock: formatSubagentsForPrompt(args.persona),
  });

  const subagentSystemPrompt = args.persona.tools.includes(TOOL_NAME_SPAWN_AGENT)
    ? buildBaseSystemPrompt({
        personaSystemPrompt: buildSubagentSystemPrompt(args.persona.systemPrompt),
        skillsBlock: args.skillsBlock,
        projectContextBlock: args.projectContextBlock,
        environmentTag,
      })
    : undefined;

  return {
    environmentTag,
    baseSystemPrompt,
    ...(subagentSystemPrompt !== undefined ? { subagentSystemPrompt } : {}),
  };
}
