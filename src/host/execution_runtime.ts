import { loadSkillsFromToolBackend } from "../core/config/runtime_config_snapshot.js";
import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import type { ResolveSubagentPrompt } from "../core/tools/spawn_agent.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";

export function createExecutionEnvironmentSubagentPromptResolver(options: {
  sessionId: string;
  executionEnvironment: ExecutionEnvironment;
  includeAgentContext: boolean;
  sessionStartedAt: number;
}): ResolveSubagentPrompt {
  return async ({ cwd, persona }) => {
    const { skills } = await loadSkillsFromToolBackend({
      backend: options.executionEnvironment.getToolExecutionBackend(),
      cwd,
      home: options.executionEnvironment.snapshot().home,
    });
    const runtimeContext = await options.executionEnvironment.resolveRuntimeContext({
      cwd,
      discoveredSkills: skills,
      includeAgentContext: options.includeAgentContext,
    });
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    return composeSessionPrompts({
      persona,
      sessionId: options.sessionId,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      repository: promptContext.repository,
      sessionStartedAt: new Date(options.sessionStartedAt).toISOString(),
      platform: promptContext.platform,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
    }).subagentSystemPrompt;
  };
}
