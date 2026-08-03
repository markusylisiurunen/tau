import type { Skill } from "../types.js";

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
    "- Trigger: Follow the skill's trigger sensitivity if specified; default is balanced. An exact `@@skill:<name>` reference in the user request, active AGENTS.md instructions, or instructions of an already-active skill explicitly activates that skill. Skill references compose transitively. Activate each skill at most once per request; repeated or cyclic references do not reopen it. Do not infer skill activation from generic language, keyword, or task overlap. Use the minimal set of skills that covers the request.",
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
  parts.push(args.environmentTag.trim());
  return parts.join("\n\n");
}

export function buildProjectContextBlock(args: {
  agentsFiles: string[];
  childAgentsFiles: string[];
  readFile: (path: string) => string;
}): string | undefined {
  const agentsFiles = args.agentsFiles;
  const injectedAgentsFiles = new Set(agentsFiles);
  const childAgentsFiles = args.childAgentsFiles.filter(
    (filePath) => !injectedAgentsFiles.has(filePath),
  );
  if (agentsFiles.length === 0 && childAgentsFiles.length === 0) return undefined;

  const lines: string[] = ["### Project context", ""];
  const readFile = args.readFile;

  for (const filePath of agentsFiles) {
    let content = "";
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    lines.push(`<file path="${escapeXml(filePath)}">`);
    lines.push(content.trimEnd());
    lines.push("</file>");
    lines.push("");
  }

  if (childAgentsFiles.length > 0) {
    lines.push("Nested AGENTS.md files under the current working directory (paths only):");
    lines.push("");
    lines.push("<nested-agents-files>");
    for (const filePath of childAgentsFiles) {
      lines.push(`  <file path="${escapeXml(filePath)}" />`);
    }
    lines.push("</nested-agents-files>");
  }

  const out = lines.join("\n").trimEnd();
  return out.trim() ? out : undefined;
}

export function buildEnvironmentTag(args: {
  datetime: string;
  cwd: string;
  repoRoot?: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
}): string {
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
    `  <node>${nodeVersion}</node>`,
    `  <platform>${platform}</platform>`,
    "</environment>",
  );

  return lines.join("\n");
}
