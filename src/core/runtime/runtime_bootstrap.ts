import { dirname, join, parse, resolve, sep } from "node:path/posix";
import type { Persona, Skill } from "../types.js";
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

  if (personaSkills.length === 0) {
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
    if (!trimmed) {
      throw new Error(`persona '${args.persona.id}' has an empty skill name`);
    }

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
  readFile: (path: string) => string;
};

export type RuntimePromptBootstrapFilesystem = {
  readFile(path: string): Promise<string>;
  runBash?(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ output: string; exitCode: number | null }>;
  listDir(path: string): Promise<
    {
      name: string;
      isDirectory: boolean;
      isSymlink: boolean;
    }[]
  >;
};

export type ResolveRuntimePromptBootstrapAsyncArgs = Omit<
  ResolveRuntimePromptBootstrapArgs,
  "readFile"
> & {
  fs: RuntimePromptBootstrapFilesystem;
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
      cwd: args.cwd,
      home: args.home,
      includeAgentContext: args.includeAgentContext,
      projectContextBlock: projectContext.projectContextBlock,
      skillsBlock: resolvedSkills.skillsBlock,
    },
    agentsFiles: projectContext.agentsFiles,
    warnings: projectContext.warnings,
    unknownSkills: resolvedSkills.unknown,
  };
}

const DEFAULT_IGNORED_CHILD_DIRS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".jj",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svn",
  ".turbo",
  ".venv",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

const CHILD_AGENTS_WALK_MAX_DIRS = 10_000;
const TOOL_BACKEND_PROJECT_CONTEXT_TIMEOUT_MS = 15_000;

export async function resolveRuntimePromptBootstrapAsync(
  args: ResolveRuntimePromptBootstrapAsyncArgs,
): Promise<RuntimePromptBootstrap> {
  const projectContext = await resolveProjectContextForPromptContextAsync({
    cwd: args.cwd,
    home: args.home,
    includeAgentContext: args.includeAgentContext,
    fs: args.fs,
  });
  const resolvedSkills = resolvePersonaSkillsForPromptContext({
    persona: args.persona,
    discoveredSkills: args.discoveredSkills,
  });

  return {
    promptContext: {
      cwd: args.cwd,
      home: args.home,
      includeAgentContext: args.includeAgentContext,
      projectContextBlock: projectContext.projectContextBlock,
      skillsBlock: resolvedSkills.skillsBlock,
    },
    agentsFiles: projectContext.agentsFiles,
    warnings: projectContext.warnings,
    unknownSkills: resolvedSkills.unknown,
  };
}

async function resolveProjectContextForPromptContextAsync(args: {
  cwd: string;
  home: string;
  includeAgentContext: boolean;
  fs: RuntimePromptBootstrapFilesystem;
}): Promise<ResolvedProjectContext> {
  if (!args.includeAgentContext) {
    return { agentsFiles: [], warnings: [], projectContextBlock: undefined };
  }

  if (args.fs.runBash) {
    return await resolveProjectContextWithCommandAsync({
      cwd: args.cwd,
      home: args.home,
      runBash: args.fs.runBash,
    });
  }

  const agentsFiles = await findAgentsFilesFromCwdToHomeAsync(args.cwd, args.home, args.fs);
  const childAgentsFiles = await findChildAgentsFilesAsync(args.cwd, args.fs);
  const projectContextBlock = await buildProjectContextBlockAsync({
    cwd: args.cwd,
    home: args.home,
    agentsFiles,
    childAgentsFiles,
    readFile: args.fs.readFile,
  });

  return {
    agentsFiles,
    warnings: [],
    projectContextBlock,
  };
}

async function resolveProjectContextWithCommandAsync(args: {
  cwd: string;
  home: string;
  runBash: NonNullable<RuntimePromptBootstrapFilesystem["runBash"]>;
}): Promise<ResolvedProjectContext> {
  const result = await args.runBash(buildResolveProjectContextCommand(args.cwd, args.home), {
    timeoutMs: TOOL_BACKEND_PROJECT_CONTEXT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return { agentsFiles: [], warnings: [], projectContextBlock: undefined };
  }

  const parsed = parseProjectContextCommandOutput(args.cwd, result.output);
  const contentByPath = new Map(parsed.agentsFiles.map((file) => [file.path, file.content]));
  const projectContextBlock = await buildProjectContextBlockAsync({
    cwd: args.cwd,
    home: args.home,
    agentsFiles: parsed.agentsFiles.map((file) => file.path),
    childAgentsFiles: parsed.childAgentsFiles,
    readFile: async (path) => {
      const content = contentByPath.get(path);
      if (content === undefined) {
        throw new Error(`missing decoded AGENTS.md content for ${path}`);
      }
      return content;
    },
  });

  return {
    agentsFiles: parsed.agentsFiles.map((file) => file.path),
    warnings: [],
    projectContextBlock,
  };
}

async function fileExists(path: string, fs: RuntimePromptBootstrapFilesystem): Promise<boolean> {
  try {
    await fs.readFile(path);
    return true;
  } catch {
    return false;
  }
}

function isSameOrParentPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const root = parse(parent).root;
  if (parent === root) return child.startsWith(root);
  return child.startsWith(parent + sep);
}

async function findAgentsFilesFromCwdToHomeAsync(
  cwd: string,
  home: string,
  fs: RuntimePromptBootstrapFilesystem,
): Promise<string[]> {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);
  const withinHome = cwdAbs === homeAbs || cwdAbs.startsWith(homeAbs + sep);
  const stopAbs = withinHome ? homeAbs : parse(cwdAbs).root;
  const found: string[] = [];

  let dir = cwdAbs;
  while (true) {
    const candidate = join(dir, "AGENTS.md");
    if (await fileExists(candidate, fs)) {
      found.push(candidate);
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return found;
}

async function findChildAgentsFilesAsync(
  cwd: string,
  fs: RuntimePromptBootstrapFilesystem,
): Promise<string[]> {
  const cwdAbs = resolve(cwd);
  const found: string[] = [];
  const seenDirs = new Set<string>();
  let visitedDirs = 0;

  const walk = async (dir: string): Promise<void> => {
    if (visitedDirs >= CHILD_AGENTS_WALK_MAX_DIRS) return;
    if (seenDirs.has(dir)) return;
    seenDirs.add(dir);
    visitedDirs += 1;

    let entries: Awaited<ReturnType<RuntimePromptBootstrapFilesystem["listDir"]>>;
    try {
      entries = await fs.listDir(dir);
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (visitedDirs >= CHILD_AGENTS_WALK_MAX_DIRS) return;
      if (!entry.isDirectory && !entry.isSymlink) continue;
      if (DEFAULT_IGNORED_CHILD_DIRS.has(entry.name)) continue;

      const childDir = join(dir, entry.name);
      const candidate = join(childDir, "AGENTS.md");
      if ((await fileExists(candidate, fs)) && isSameOrParentPath(cwdAbs, candidate)) {
        found.push(candidate);
      }

      await walk(childDir);
    }
  };

  await walk(cwdAbs);
  return found.filter((filePath) => dirname(filePath) !== cwdAbs);
}

function buildFindChildAgentsFilesCommand(cwd: string): string {
  const ignoredExpression = [...DEFAULT_IGNORED_CHILD_DIRS]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `-name ${shellQuote(name)}`)
    .join(" -o ");
  return [
    "find",
    shellQuote(cwd),
    "\\(",
    ignoredExpression,
    "\\)",
    "-prune",
    "-o",
    "-type",
    "f",
    "-name",
    shellQuote("AGENTS.md"),
    "-print",
    "2>/dev/null",
    "|",
    "head",
    "-n",
    String(CHILD_AGENTS_WALK_MAX_DIRS),
  ].join(" ");
}

function buildResolveProjectContextCommand(cwd: string, home: string): string {
  const ancestorFiles = findAncestorAgentsFileCandidates(cwd, home);
  const ancestors = ancestorFiles.map(shellQuote).join(" ");
  return [
    "for file in",
    ancestors,
    "; do",
    '[ -f "$file" ] || continue;',
    "printf 'A\\t';",
    "printf '%s' \"$file\" | base64 | tr -d '\\n';",
    "printf '\\t';",
    "base64 < \"$file\" | tr -d '\\n';",
    "printf '\\n';",
    "done;",
    buildFindChildAgentsFilesCommand(cwd),
    "| while IFS= read -r file; do",
    "printf 'C\\t';",
    "printf '%s' \"$file\" | base64 | tr -d '\\n';",
    "printf '\\n';",
    "done",
  ].join(" ");
}

function findAncestorAgentsFileCandidates(cwd: string, home: string): string[] {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);
  const withinHome = cwdAbs === homeAbs || cwdAbs.startsWith(homeAbs + sep);
  const stopAbs = withinHome ? homeAbs : parse(cwdAbs).root;
  const candidates: string[] = [];

  let dir = cwdAbs;
  while (true) {
    candidates.push(join(dir, "AGENTS.md"));
    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return candidates;
}

function parseProjectContextCommandOutput(
  cwd: string,
  output: string,
): {
  agentsFiles: Array<{ path: string; content: string }>;
  childAgentsFiles: string[];
} {
  const cwdAbs = resolve(cwd);
  const agentsFiles: Array<{ path: string; content: string }> = [];
  const childAgentsFiles: string[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [kind, encodedPath, encodedContent] = line.split("\t");
    if (!kind || !encodedPath) {
      throw new Error("invalid project context command output");
    }

    const filePath = decodeBase64Utf8(encodedPath);
    if (!filePath) {
      throw new Error("project context command returned an empty path");
    }
    if (kind === "A") {
      if (!isSameOrParentPath(dirname(filePath), cwdAbs)) continue;
      if (encodedContent === undefined) {
        throw new Error(`project context command returned AGENTS.md without content: ${filePath}`);
      }
      agentsFiles.push({
        path: filePath,
        content: decodeBase64Utf8(encodedContent),
      });
      continue;
    }

    if (kind === "C" && isSameOrParentPath(cwdAbs, filePath) && dirname(filePath) !== cwdAbs) {
      childAgentsFiles.push(filePath);
      continue;
    }

    if (kind !== "C") {
      throw new Error(`unknown project context command output row '${kind}'`);
    }
  }

  return { agentsFiles, childAgentsFiles };
}

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf-8");
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function buildProjectContextBlockAsync(args: {
  cwd: string;
  home: string;
  agentsFiles: string[];
  childAgentsFiles: string[];
  readFile: (path: string) => Promise<string>;
}): Promise<string | undefined> {
  const injectedAgentsFiles = new Set(args.agentsFiles);
  const childAgentsFiles = args.childAgentsFiles.filter(
    (filePath) => !injectedAgentsFiles.has(filePath),
  );
  if (args.agentsFiles.length === 0 && childAgentsFiles.length === 0) return undefined;

  const escapeXml = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");

  const lines: string[] = ["### Project context", ""];

  for (const filePath of args.agentsFiles) {
    let content = "";
    try {
      content = await args.readFile(filePath);
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
