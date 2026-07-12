import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import type { ResolveSubagentRuntime } from "../core/tools/registry.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";

export function createExecutionEnvironmentSubagentRuntimeResolver(options: {
  executionEnvironment: ExecutionEnvironment;
  includeAgentContext: boolean;
  now: () => number;
}): ResolveSubagentRuntime {
  return async ({ cwd, persona, name }) => {
    const runtimeConfig = await options.executionEnvironment.resolveRuntimeConfig(cwd);
    const runtimeContext = await options.executionEnvironment.resolveRuntimeContext({
      cwd,
      persona,
      discoveredSkills: runtimeConfig.skills,
      includeAgentContext: options.includeAgentContext,
      agentContextFiles: runtimeConfig.config.agentContextFiles ?? [],
    });
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    const composition = composeSessionPrompts({
      persona,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      datetime: new Date(options.now()).toISOString(),
      platform: promptContext.platform,
      nodeVersion: promptContext.nodeVersion,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
    });
    const systemPrompt = composition.subagentPrompts[name];
    if (!systemPrompt) {
      throw new Error(`subagent '${name}' is missing its system prompt`);
    }
    return {
      config: runtimeConfig.config,
      modelResolver: runtimeConfig.bootstrap.modelResolver.resolveModel,
      systemPrompt,
    };
  };
}
