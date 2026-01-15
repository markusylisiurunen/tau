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
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.path)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");

  lines.push(
    "",
    "Guidelines:",
    "- Trigger: Follow the skill's trigger sensitivity if specified; default is balanced. Always activate if user names it (e.g. `$skill-name`). Use the minimal set of skills that covers the request.",
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
  environmentTag: string;
  previousSessionSummary?: string;
  subagentsBlock?: string;
}): string {
  const parts: string[] = [args.personaSystemPrompt.trim()];
  if (args.skillsBlock?.trim()) {
    parts.push(args.skillsBlock.trim());
  }
  if (args.projectContextBlock?.trim()) {
    parts.push(args.projectContextBlock.trim());
  }
  if (args.previousSessionSummary?.trim()) {
    parts.push(
      [
        "### Previous session context",
        "",
        "The following is a summary of a previous conversation session that provides relevant context:",
        "<previous_session_summary>",
        args.previousSessionSummary.trim(),
        "</previous_session_summary>",
      ].join("\n"),
    );
  }
  if (args.subagentsBlock?.trim()) {
    parts.push(args.subagentsBlock.trim());
  }
  parts.push(args.environmentTag.trim());
  return parts.join("\n\n");
}

export function buildProjectContextBlock(args: {
  cwd: string;
  home: string;
  agentsFiles?: string[];
  readFile: (path: string) => string;
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
    lines.push(`<file path="${filePath}">`);
    lines.push(content.trimEnd());
    lines.push("</file>");
    lines.push("");
  }

  const out = lines.join("\n").trimEnd();
  return out.trim() ? out : undefined;
}

export function describeRiskLevel(level: RiskLevel): string {
  switch (level) {
    case "restricted":
      return "Model can only use restricted tools (read/grep/list) scoped to the repo root.";
    case "read-only":
      return "Model may call bash only for read-only commands (safetyLevel='read').";
    case "read-write":
      return "Model may call bash for read or write commands (safetyLevel='read' or 'write').";
  }
}

export function buildEnvironmentTag(args: {
  datetime: string;
  cwd: string;
  riskLevel: RiskLevel;
  platform: NodeJS.Platform;
  nodeVersion: string;
}): string {
  const riskDesc = describeRiskLevel(args.riskLevel);
  const nodeVersion = args.nodeVersion;
  const platform = args.platform;
  return [
    "<environment>",
    `  <datetime>${args.datetime}</datetime>`,
    `  <cwd>${args.cwd}</cwd>`,
    `  <risk_level level="${args.riskLevel}">${riskDesc}</risk_level>`,
    `  <node>${nodeVersion}</node>`,
    `  <platform>${platform}</platform>`,
    "  <notes>This environment tag is static for the session and reflects the initial risk level. If the user changes risk level, you will be informed in a <system> tag at the start of the next user message.</notes>",
    "</environment>",
  ].join("\n");
}

export function formatRiskLevelChangeNotice(change: { from: RiskLevel; to: RiskLevel }): string {
  const toDesc = describeRiskLevel(change.to);
  return `<system>Risk level changed by user from '${change.from}' to '${change.to}'. ${toDesc} This overrides the initial risk level described in the system prompt.</system>`;
}
