import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import type { ResolveSubagentPrompts } from "../core/tools/spawn_agent.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";

export function createExecutionEnvironmentSubagentPromptResolver(options: {
  executionEnvironment: ExecutionEnvironment;
  includeAgentContext: boolean;
  now: () => number;
}): ResolveSubagentPrompts {
  return async ({ cwd, persona }) => {
    const { config, skills } = await options.executionEnvironment.resolveRuntimeConfig(cwd);
    const runtimeContext = await options.executionEnvironment.resolveRuntimeContext({
      cwd,
      persona,
      discoveredSkills: skills,
      includeAgentContext: options.includeAgentContext,
      agentContextFiles: config.agentContextFiles ?? [],
    });
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    return composeSessionPrompts({
      persona,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      datetime: new Date(options.now()).toISOString(),
      platform: promptContext.platform,
      nodeVersion: promptContext.nodeVersion,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
    }).subagentPrompts;
  };
}
