import type { RiskLevel, Skill } from "../types.js";
import { findAgentsFilesInScope } from "./agents_files.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildSkillsIndexBlock(skills: Skill[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  const intro = [
    "Skills are local, on-disk packages of domain expertise.",
    "Each skill is a directory containing a `SKILL.md` (YAML frontmatter + instructions), and may include `references/`, `scripts/`, and `assets/`.",
  ].join(" ");

  const lines: string[] = [
    "### Skills",
    "",
    intro,
    "",
    "Discovered skills:",
    "",
    "<available-skills>",
  ];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.path)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available-skills>");

  lines.push(
    "",
    "Guidelines:",
    "- Trigger: Follow the skill's trigger sensitivity if specified; default is balanced. Always activate if user names it with `@@skill:<name>`. For explicit triggers, only activate when the user explicitly names the skill (for example with `@@skill:<name>`), not based on keyword overlap. Use the minimal set of skills that covers the request.",
    "- Activation: After deciding to use a skill, open `SKILL.md` from the <location> (e.g. `cat <path>`). Read only what you need to follow the workflow.",
    "- Resources: If `SKILL.md` references files in `references/` or `assets/`, load only the specific files you need. Don't bulk-load directories.",
    "- Scripts: If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.",
    "- Paths: Paths in `SKILL.md` are relative to the skill directory.",
    "- Missing: If a named skill isn't listed or its `SKILL.md` can't be read, say so briefly and continue with the best fallback.",
    "- Read-only: Never modify skill files (`SKILL.md`, `references/`, `scripts/`, `assets/`) unless the user explicitly asks to edit skills.",
  );

  return lines.join("\n").trimEnd();
}

export function buildBaseSystemPrompt(args: {
  personaSystemPrompt: string;
  skillsBlock?: string;
  projectContextBlock?: string;
  sandboxInfoBlock?: string;
  environmentTag: string;
  subagentsBlock?: string;
}): string {
  const parts: string[] = [args.personaSystemPrompt.trim()];
  if (args.skillsBlock?.trim()) {
    parts.push(args.skillsBlock.trim());
  }
  if (args.projectContextBlock?.trim()) {
    parts.push(args.projectContextBlock.trim());
  }
  if (args.subagentsBlock?.trim()) {
    parts.push(args.subagentsBlock.trim());
  }
  if (args.sandboxInfoBlock?.trim()) {
    parts.push(args.sandboxInfoBlock.trim());
  }
  parts.push(args.environmentTag.trim());
  return parts.join("\n\n");
}

export function buildSandboxInfoBlock(info?: string): string | undefined {
  const trimmed = info?.trim();
  if (!trimmed) return undefined;
  return ["### Sandbox environment", "", "<sandbox-info>", trimmed, "</sandbox-info>"].join("\n");
}

export function buildProjectContextBlock(args: {
  cwd: string;
  home: string;
  agentsFiles?: string[];
  readFile: (path: string) => string;
  pathForPrompt?: (path: string) => string;
}): string | undefined {
  const agentsFiles = args.agentsFiles ?? findAgentsFilesInScope(args.cwd, args.home);
  if (agentsFiles.length === 0) return undefined;

  const lines: string[] = ["### Project context", ""];
  const readFile = args.readFile;

  for (const filePath of agentsFiles) {
    let content = "";
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    const promptPath = args.pathForPrompt?.(filePath) ?? filePath;
    lines.push(`<file path="${escapeXml(promptPath)}">`);
    lines.push(content.trimEnd());
    lines.push("</file>");
    lines.push("");
  }

  const out = lines.join("\n").trimEnd();
  return out.trim() ? out : undefined;
}

export function describeRiskLevel(level: RiskLevel): string {
  switch (level) {
    case "read-only":
      return "Model may use tools in read-only mode; bash safetyLevel must be 'read' and write/edit tools are blocked.";
    case "read-write":
      return "Model may use all tools and bash for read or write commands (safetyLevel='read' or 'write').";
  }
}

export function buildEnvironmentTag(args: {
  datetime: string;
  cwd: string;
  repoRoot?: string;
  riskLevel: RiskLevel;
  platform: NodeJS.Platform;
  nodeVersion: string;
}): string {
  const riskDesc = describeRiskLevel(args.riskLevel);
  const nodeVersion = args.nodeVersion;
  const platform = args.platform;
  const lines = [
    "<environment>",
    `  <datetime>${args.datetime}</datetime>`,
    `  <cwd>${args.cwd}</cwd>`,
  ];

  if (args.repoRoot) {
    lines.push(`  <repo-root>${args.repoRoot}</repo-root>`);
  }

  lines.push(
    `  <risk-level level="${args.riskLevel}">${riskDesc}</risk-level>`,
    `  <node>${nodeVersion}</node>`,
    `  <platform>${platform}</platform>`,
    "  <notes>This environment tag reflects the current session environment. If the user changes risk level or cwd, you will be informed in a <system> tag at the start of the next user message.</notes>",
    "</environment>",
  );

  return lines.join("\n");
}

export function formatRiskLevelChangeNotice(change: { from: RiskLevel; to: RiskLevel }): string {
  const toDesc = describeRiskLevel(change.to);
  return `<system>Risk level changed by user from '${change.from}' to '${change.to}'. ${toDesc} This overrides the initial risk level described in the system prompt.</system>`;
}

export function formatCwdChangeNotice(change: { from: string; to: string }): string {
  return `<system>Working directory changed by user from '${change.from}' to '${change.to}'. All relative paths should now resolve from '${change.to}'.</system>`;
}

export function formatProjectContextChangeNotice(change: { projectContextBlock?: string }): string {
  if (!change.projectContextBlock?.trim()) {
    return "<system>Project context changed by user after '/cd'. AGENTS/project context is now empty in the current working directory scope.</system>";
  }

  const sanitizedProjectContextBlock = change.projectContextBlock.replaceAll(
    "</system>",
    "<\\/system>",
  );

  return [
    "<system>",
    "Project context changed by user after '/cd'. Replace any previously provided AGENTS/project context with the following updated block.",
    "<project-context-update>",
    sanitizedProjectContextBlock,
    "</project-context-update>",
    "</system>",
  ].join("\n");
}
