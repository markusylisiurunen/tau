import type { Stats } from "node:fs";
import { dirname } from "node:path";
import type { ConfigDeps } from "../core/config/deps.js";
import {
  loadPromptTemplate,
  loadRuntimeConfig,
  type RuntimeConfigResult,
} from "../core/config/index.js";
import type { PromptTemplate } from "../core/prompts.js";
import type { BashExecutionResult, ToolExecutionBackend } from "../core/tools/execution_backend.js";
import { shellQuote } from "./sandbox_tool_helpers.js";

type RuntimeConfigFileSnapshot = {
  path: string;
  content: string;
};

type RuntimeConfigSnapshot = {
  files: RuntimeConfigFileSnapshot[];
};

const COLLECT_RUNTIME_CONFIG_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");

const cwd = path.resolve(process.argv[1]);
const home = path.resolve(process.argv[2]);
const files = new Map();

function stat(pathname) {
  try {
    return fs.statSync(pathname);
  } catch {
    return undefined;
  }
}

function isDirectory(pathname) {
  return Boolean(stat(pathname)?.isDirectory());
}

function addFile(pathname) {
  const info = stat(pathname);
  if (!info?.isFile()) return;
  try {
    files.set(path.resolve(pathname), fs.readFileSync(pathname, "utf8"));
  } catch {}
}

function addFiles(dir, suffix) {
  if (!isDirectory(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith(suffix)) {
      addFile(path.join(dir, entry));
    }
  }
}

function addSkills(dir) {
  if (!isDirectory(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    if (isDirectory(skillDir)) {
      addFile(path.join(skillDir, "SKILL.md"));
    }
  }
}

function addLevel(root, configDir) {
  addFile(path.join(configDir, "config.json"));
  addFile(path.join(configDir, "models.json"));
  addFiles(path.join(configDir, "personas"), ".md");
  addFiles(path.join(configDir, "prompts"), ".md");
  addFiles(path.join(configDir, "themes"), ".json");
  addSkills(path.join(configDir, "skills"));
  addSkills(path.join(root, ".agents", "skills"));
}

const withinHome = cwd === home || cwd.startsWith(home + path.sep);
if (withinHome) {
  addLevel(home, path.join(home, ".config", "tau"));
}

const stop = withinHome ? home : path.parse(cwd).root;
const roots = [];
let dir = cwd;
while (true) {
  if (isDirectory(path.join(dir, ".tau")) || isDirectory(path.join(dir, ".agents", "skills"))) {
    roots.push(dir);
  }
  if (dir === stop) break;
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
roots.reverse();
for (const root of roots) {
  addLevel(root, path.join(root, ".tau"));
}

process.stdout.write(JSON.stringify({
  files: [...files.entries()].map(([filePath, content]) => ({ path: filePath, content }))
}));
`;

const COLLECT_PROMPT_TEMPLATE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");

const cwd = path.resolve(process.argv[1]);
const home = path.resolve(process.argv[2]);
const promptId = String(process.argv[3] || "").toLowerCase();
const files = new Map();

function stat(pathname) {
  try {
    return fs.statSync(pathname);
  } catch {
    return undefined;
  }
}

function isDirectory(pathname) {
  return Boolean(stat(pathname)?.isDirectory());
}

function addPrompt(configDir) {
  const promptsDir = path.join(configDir, "prompts");
  if (!isDirectory(promptsDir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(promptsDir);
  } catch {
    return;
  }
  const fileName = entries.find((entry) => entry.toLowerCase() === promptId + ".md");
  if (!fileName) return;
  const filePath = path.join(promptsDir, fileName);
  const info = stat(filePath);
  if (!info?.isFile()) return;
  try {
    files.set(path.resolve(filePath), fs.readFileSync(filePath, "utf8"));
  } catch {}
}

const withinHome = cwd === home || cwd.startsWith(home + path.sep);
if (withinHome) {
  addPrompt(path.join(home, ".config", "tau"));
}

const stop = withinHome ? home : path.parse(cwd).root;
const roots = [];
let dir = cwd;
while (true) {
  if (isDirectory(path.join(dir, ".tau")) || isDirectory(path.join(dir, ".agents", "skills"))) {
    roots.push(dir);
  }
  if (dir === stop) break;
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
roots.reverse();
for (const root of roots) {
  addPrompt(path.join(root, ".tau"));
}

process.stdout.write(JSON.stringify({
  files: [...files.entries()].map(([filePath, content]) => ({ path: filePath, content }))
}));
`;

export async function loadRuntimeConfigFromToolBackend(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  home: string;
}): Promise<RuntimeConfigResult> {
  const result = await options.backend.runBash(
    `node -e ${shellQuote(COLLECT_RUNTIME_CONFIG_SCRIPT)} ${shellQuote(options.cwd)} ${shellQuote(
      options.home,
    )}`,
    { cwd: options.cwd, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(formatConfigSnapshotCommandFailure(result));
  }

  const snapshot = parseRuntimeConfigSnapshot(result.output);
  return await loadRuntimeConfig(
    options.cwd,
    createRuntimeConfigSnapshotDeps({
      cwd: options.cwd,
      home: options.home,
      snapshot,
    }),
  );
}

export async function loadPromptTemplateFromToolBackend(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  home: string;
  promptId: string;
}): Promise<PromptTemplate | undefined> {
  const result = await options.backend.runBash(
    `node -e ${shellQuote(COLLECT_PROMPT_TEMPLATE_SCRIPT)} ${shellQuote(options.cwd)} ${shellQuote(
      options.home,
    )} ${shellQuote(options.promptId)}`,
    { cwd: options.cwd, timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(formatConfigSnapshotCommandFailure(result));
  }

  const snapshot = parseRuntimeConfigSnapshot(result.output);
  return loadPromptTemplate(
    options.cwd,
    createRuntimeConfigSnapshotDeps({
      cwd: options.cwd,
      home: options.home,
      snapshot,
    }),
    options.promptId,
  );
}

function formatConfigSnapshotCommandFailure(result: BashExecutionResult): string {
  const output = result.output.trim();
  return output
    ? `failed to collect execution environment config: ${output}`
    : "failed to collect execution environment config";
}

function parseRuntimeConfigSnapshot(output: string): RuntimeConfigSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("execution environment returned invalid config snapshot JSON", {
      cause: error,
    });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as RuntimeConfigSnapshot).files)
  ) {
    throw new Error("execution environment returned invalid config snapshot shape");
  }

  const files: RuntimeConfigFileSnapshot[] = [];
  for (const file of (parsed as RuntimeConfigSnapshot).files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    ) {
      throw new Error("execution environment returned invalid config snapshot file entry");
    }
    files.push({ path: file.path, content: file.content });
  }

  return { files };
}

function createRuntimeConfigSnapshotDeps(options: {
  cwd: string;
  home: string;
  snapshot: RuntimeConfigSnapshot;
}): ConfigDeps {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  for (const file of options.snapshot.files) {
    files.set(file.path, file.content);
    let dir = dirname(file.path);
    while (!dirs.has(dir)) {
      dirs.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return {
    fs: {
      readFile: (path) => {
        const content = files.get(path);
        if (content === undefined) {
          throw new Error(`file not found: ${path}`);
        }
        return content;
      },
      exists: (path) => files.has(path) || dirs.has(path),
      listDir: (path) => {
        if (!dirs.has(path)) {
          throw new Error(`directory not found: ${path}`);
        }

        const names = new Set<string>();
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const filePath of files.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          const [name] = rest.split("/");
          if (name) names.add(name);
        }
        for (const dirPath of dirs) {
          if (!dirPath.startsWith(prefix) || dirPath === path) continue;
          const rest = dirPath.slice(prefix.length);
          const [name] = rest.split("/");
          if (name) names.add(name);
        }
        return [...names].sort((a, b) => a.localeCompare(b));
      },
      stat: (path) => {
        if (dirs.has(path)) {
          return { isDirectory: () => true } as Stats;
        }
        if (files.has(path)) {
          return { isDirectory: () => false } as Stats;
        }
        throw new Error(`path not found: ${path}`);
      },
    },
    env: {
      getEnv: () => ({}),
      cwd: () => options.cwd,
      home: () => options.home,
    },
  };
}
