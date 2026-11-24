import { loadSkillsFromToolBackend } from "../core/config/runtime_config_snapshot.js";
import type { McpServerSummary } from "../core/mcp/manager.js";
import { composeSubagentSystemPrompt } from "../core/runtime/session_prompt_composer.js";
import type { ResolveSubagentPrompt } from "../core/subagents/types.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";

export function createExecutionEnvironmentSubagentPromptResolver(options: {
  sessionId: string;
  executionEnvironment: ExecutionEnvironment;
  includeAgentContext: boolean;
  sessionStartedAt: number;
  mcpServers: readonly McpServerSummary[];
}): ResolveSubagentPrompt {
  return async ({ cwd, persona }) => {
    const promptContext = await resolveDirectoryPromptContext(
      options.executionEnvironment,
      cwd,
      options.includeAgentContext,
    );
    return composeSubagentSystemPrompt({
      persona,
      sessionId: options.sessionId,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      repository: promptContext.repository,
      sessionStartedAt: new Date(options.sessionStartedAt).toISOString(),
      platform: promptContext.platform,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
      mcpServers: options.mcpServers,
    });
  };
}

export async function resolveDirectoryPromptContext(
  environment: ExecutionEnvironment,
  cwd: string,
  includeAgentContext: boolean,
) {
  const { skills } = await loadSkillsFromToolBackend({
    backend: environment.getToolExecutionBackend(),
    cwd,
    home: environment.snapshot().home,
  });
  const runtimeContext = await environment.resolveRuntimeContext({
    cwd,
    discoveredSkills: skills,
    includeAgentContext,
  });
  return runtimeContext.promptBootstrap.promptContext;
}
