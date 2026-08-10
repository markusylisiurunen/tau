import {
  MAX_COMMAND_CAPTURE_BYTES,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import type { Persona, Skill } from "../types.js";
import { buildProjectContextBlock, buildSkillsIndexBlock } from "../utils/context_builder.js";
import { normalizeRepositoryReference } from "../utils/repository.js";
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

export type ResolveRuntimePromptBootstrapArgs = {
  persona: Persona;
  discoveredSkills: Skill[];
  cwd: string;
  home: string;
  includeAgentContext: boolean;
  agentContextFiles: string[];
  backend: ToolExecutionBackend;
};

export type RuntimePromptBootstrap = {
  promptContext: ChatRuntimePromptContext;
  agentsFiles: string[];
  unknownSkills: string[];
};

const INSPECT_RUNTIME_PROMPT_CONTEXT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cwd = path.resolve(process.argv[1]);
const home = path.resolve(process.argv[2]);
const includeAgentContext = process.argv[3] === "true";
const additionalFiles = JSON.parse(process.argv[4]);
const ignoredChildDirs = new Set(JSON.parse(process.argv[5]));
const ignoredHomeChildDirs = new Set(JSON.parse(process.argv[6]));
const ignoredPlatformHomeChildDirs = new Set(
  process.platform === "darwin" ? ["Library"] : process.platform === "linux" ? ["snap"] : [],
);
const maxDirs = Number(process.argv[7]);
const maxDepth = Number(process.argv[8]);

function realpath(pathname) {
  try {
    return fs.realpathSync(pathname);
  } catch {
    return undefined;
  }
}

function isSameOrParent(parent, child) {
  if (parent === child) return true;
  const root = path.parse(parent).root;
  if (parent === root) return child.startsWith(root);
  return child.startsWith(parent + path.sep);
}

const cwdReal = realpath(cwd) || cwd;
const homeReal = realpath(home) || home;
const cwdWithinHome = isSameOrParent(homeReal, cwdReal);

function resolveContextFile(pathname, requireAgentsBasename) {
  const resolved = path.resolve(pathname);
  if (requireAgentsBasename && path.basename(resolved) !== "AGENTS.md") return undefined;
  const canonical = realpath(resolved);
  if (!canonical || (requireAgentsBasename && path.basename(canonical) !== "AGENTS.md")) {
    return undefined;
  }
  let stat;
  try {
    stat = fs.statSync(canonical);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (cwdWithinHome && !isSameOrParent(homeReal, canonical)) return undefined;
  const fileDir = path.dirname(canonical);
  if (!isSameOrParent(fileDir, cwdReal) && !isSameOrParent(cwdReal, fileDir)) return undefined;
  return { path: resolved, canonical };
}

function ancestorCandidates() {
  const stop = cwdWithinHome ? home : path.parse(cwd).root;
  const candidates = [];
  let dir = cwd;
  while (true) {
    candidates.push(path.join(dir, "AGENTS.md"));
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

const agentsFiles = [];
const seenFiles = new Set();
function addContextFile(pathname, requireAgentsBasename) {
  const file = resolveContextFile(pathname, requireAgentsBasename);
  if (!file || seenFiles.has(file.canonical)) return;
  seenFiles.add(file.canonical);
  agentsFiles.push({ path: file.path, content: fs.readFileSync(file.canonical, "utf8") });
}

const childAgentsFiles = [];
if (includeAgentContext) {
  for (const candidate of ancestorCandidates()) {
    addContextFile(candidate, true);
  }
  for (const candidate of additionalFiles) {
    addContextFile(candidate, false);
  }

  const queuedDirs = new Set([cwdReal]);
  const pendingDirs = [{ dir: cwd, canonicalDir: cwdReal, depth: 0 }];
  for (let index = 0; index < pendingDirs.length; index += 1) {
    const current = pendingDirs[index];
    let entries;
    try {
      entries = fs.readdirSync(current.canonicalDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const agentsEntry = entries.find((entry) => entry.name === "AGENTS.md");
    if (
      current.depth > 0 &&
      agentsEntry &&
      (agentsEntry.isFile() || agentsEntry.isSymbolicLink())
    ) {
      const candidate = resolveContextFile(path.join(current.dir, agentsEntry.name), true);
      if (candidate && !seenFiles.has(candidate.canonical)) {
        childAgentsFiles.push(candidate.path);
      }
    }

    if (current.depth >= maxDepth) {
      continue;
    }
    for (const entry of entries) {
      if (pendingDirs.length >= maxDirs) break;
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        ignoredChildDirs.has(entry.name) ||
        (current.canonicalDir === homeReal &&
          (ignoredHomeChildDirs.has(entry.name) ||
            ignoredPlatformHomeChildDirs.has(entry.name)))
      ) {
        continue;
      }
      const childDir = path.join(current.dir, entry.name);
      const canonicalChildDir = entry.isDirectory()
        ? path.join(current.canonicalDir, entry.name)
        : realpath(childDir);
      if (
        !canonicalChildDir ||
        queuedDirs.has(canonicalChildDir) ||
        !isSameOrParent(cwdReal, canonicalChildDir)
      ) {
        continue;
      }
      queuedDirs.add(canonicalChildDir);
      pendingDirs.push({
        dir: childDir,
        canonicalDir: canonicalChildDir,
        depth: current.depth + 1,
      });
    }
  }
}

let repoRoot;
try {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = result.status === 0 ? String(result.stdout || "").trim() : "";
  if (value) repoRoot = path.resolve(value);
} catch {}

let repositoryRemote;
if (repoRoot) {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = result.status === 0 ? String(result.stdout || "").trim() : "";
    if (value) repositoryRemote = value;
  } catch {}
}

process.stdout.write(JSON.stringify({
  platform: process.platform,
  repoRoot,
  repositoryRemote,
  agentsFiles,
  childAgentsFiles: [...new Set(childAgentsFiles)].sort((a, b) => a.localeCompare(b)),
}));
`;

const DEFAULT_IGNORED_CHILD_DIRS = [
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
];

const HOME_IGNORED_CHILD_DIRS = [
  ".bun",
  ".cargo",
  ".config",
  ".deno",
  ".gradle",
  ".local",
  ".m2",
  ".npm",
  ".nvm",
  ".pnpm-store",
  ".rustup",
  ".sdkman",
  ".yarn",
];

const CHILD_AGENTS_WALK_MAX_DIRS = 8_192;
const CHILD_AGENTS_WALK_MAX_DEPTH = 16;
const RUNTIME_PROMPT_CONTEXT_TIMEOUT_MS = 15_000;

type RuntimePromptContextInspection = {
  platform: NodeJS.Platform;
  repoRoot?: string;
  repositoryRemote?: string;
  agentsFiles: Array<{ path: string; content: string }>;
  childAgentsFiles: string[];
};

export async function resolveRuntimePromptBootstrap(
  args: ResolveRuntimePromptBootstrapArgs,
): Promise<RuntimePromptBootstrap> {
  const inspection = await inspectRuntimePromptContext(args);
  const contentByPath = new Map(inspection.agentsFiles.map((file) => [file.path, file.content]));
  const projectContextBlock = args.includeAgentContext
    ? buildProjectContextBlock({
        agentsFiles: inspection.agentsFiles.map((file) => file.path),
        childAgentsFiles: inspection.childAgentsFiles,
        readFile: (path) => {
          const content = contentByPath.get(path);
          if (content === undefined) {
            throw new Error(`missing execution environment context file content for ${path}`);
          }
          return content;
        },
      })
    : undefined;
  const resolvedSkills = resolvePersonaSkillsForPromptContext({
    persona: args.persona,
    discoveredSkills: args.discoveredSkills,
  });
  const repository = inspection.repositoryRemote
    ? normalizeRepositoryReference(inspection.repositoryRemote)
    : undefined;

  return {
    promptContext: {
      cwd: args.cwd,
      home: args.home,
      repoRoot: inspection.repoRoot,
      ...(repository ? { repository } : {}),
      platform: inspection.platform,
      includeAgentContext: args.includeAgentContext,
      projectContextBlock,
      skillsBlock: resolvedSkills.skillsBlock,
    },
    agentsFiles: inspection.agentsFiles.map((file) => file.path),
    unknownSkills: resolvedSkills.unknown,
  };
}

async function inspectRuntimePromptContext(
  args: ResolveRuntimePromptBootstrapArgs,
): Promise<RuntimePromptContextInspection> {
  const result = await args.backend.runNodeScript(
    INSPECT_RUNTIME_PROMPT_CONTEXT_SCRIPT,
    [
      args.cwd,
      args.home,
      String(args.includeAgentContext),
      JSON.stringify(args.agentContextFiles),
      JSON.stringify(DEFAULT_IGNORED_CHILD_DIRS),
      JSON.stringify(HOME_IGNORED_CHILD_DIRS),
      String(CHILD_AGENTS_WALK_MAX_DIRS),
      String(CHILD_AGENTS_WALK_MAX_DEPTH),
    ],
    {
      cwd: args.cwd,
      timeoutMs: RUNTIME_PROMPT_CONTEXT_TIMEOUT_MS,
      maxCaptureBytes: MAX_COMMAND_CAPTURE_BYTES,
    },
  );
  if (result.exitCode !== 0) {
    const output = result.output.trim();
    throw new Error(
      output
        ? `failed to inspect execution environment prompt context: ${output}`
        : "failed to inspect execution environment prompt context",
    );
  }
  if (result.truncated) {
    throw new Error("execution environment prompt context exceeded the capture limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch (error) {
    throw new Error("execution environment returned invalid prompt context JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("execution environment returned invalid prompt context shape");
  }

  const value = parsed as Partial<RuntimePromptContextInspection>;
  if (
    typeof value.platform !== "string" ||
    (value.repoRoot !== undefined && typeof value.repoRoot !== "string") ||
    (value.repositoryRemote !== undefined && typeof value.repositoryRemote !== "string") ||
    !Array.isArray(value.agentsFiles) ||
    !Array.isArray(value.childAgentsFiles)
  ) {
    throw new Error("execution environment returned invalid prompt context shape");
  }
  for (const file of value.agentsFiles) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("execution environment returned invalid AGENTS.md entry");
    }
  }
  if (value.childAgentsFiles.some((path) => typeof path !== "string")) {
    throw new Error("execution environment returned invalid child AGENTS.md entry");
  }

  return value as RuntimePromptContextInspection;
}
