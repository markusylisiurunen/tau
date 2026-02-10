import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class InstallCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallCliError";
  }
}

type InstallCliOptions = {
  help: boolean;
  global: boolean;
  force: boolean;
  promptId?: string;
  skillName?: string;
};

type InstallSummary = {
  installed: number;
  skipped: number;
};

type InstallCommandOptions = {
  cwd?: string;
  home?: string;
  starterContentRoot?: string;
  log?: (message: string) => void;
};

function parseValue(
  arg: string,
  argv: string[],
  index: number,
): { value: string; nextIndex: number } {
  const eqIndex = arg.indexOf("=");
  if (eqIndex !== -1) {
    const value = arg.slice(eqIndex + 1).trim();
    if (!value) {
      throw new InstallCliError(`missing value for ${arg.slice(0, eqIndex)}`);
    }
    return { value, nextIndex: index };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new InstallCliError(`missing value for ${arg}`);
  }

  return { value: next.trim(), nextIndex: index + 1 };
}

function parseInstallArgs(argv: string[]): InstallCliOptions {
  let help = false;
  let global = false;
  let force = false;
  let promptId: string | undefined;
  let skillName: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--global") {
      global = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--prompt" || arg.startsWith("--prompt=")) {
      if (promptId !== undefined) {
        throw new InstallCliError("--prompt can only be provided once");
      }
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      promptId = parsed.value;
      continue;
    }

    if (arg === "--skill" || arg.startsWith("--skill=")) {
      if (skillName !== undefined) {
        throw new InstallCliError("--skill can only be provided once");
      }
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      skillName = parsed.value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new InstallCliError(`unknown option: ${arg}`);
    }

    throw new InstallCliError(`unexpected argument: ${arg}`);
  }

  if (promptId && skillName) {
    throw new InstallCliError("--prompt and --skill are mutually exclusive");
  }

  return { help, global, force, promptId, skillName };
}

function resolveStarterContentRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const moduleDir = dirname(currentFile);

  const candidates = [resolve(moduleDir, "../../starter"), resolve(moduleDir, "../../../starter")];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "prompts")) && existsSync(join(candidate, "skills"))) {
      return candidate;
    }
  }

  throw new InstallCliError("failed to locate starter content directory.");
}

function installPrompts(args: {
  sourceDir: string;
  targetDir: string;
  force: boolean;
  selectedPromptId?: string;
  log: (message: string) => void;
}): InstallSummary {
  const { sourceDir, targetDir, force, selectedPromptId, log } = args;
  if (!existsSync(sourceDir)) {
    throw new InstallCliError(`starter prompts directory not found: ${sourceDir}`);
  }

  const allFiles = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  let files = allFiles;
  if (selectedPromptId) {
    const selected = allFiles.find(
      (fileName) => fileName.slice(0, -3).toLowerCase() === selectedPromptId.toLowerCase(),
    );

    if (!selected) {
      const available = allFiles.map((fileName) => fileName.slice(0, -3)).join(", ") || "(none)";
      throw new InstallCliError(
        `unknown starter prompt '${selectedPromptId}'. available prompts: ${available}`,
      );
    }

    files = [selected];
  }

  if (files.length === 0) {
    return { installed: 0, skipped: 0 };
  }

  mkdirSync(targetDir, { recursive: true });

  let installed = 0;
  let skipped = 0;

  for (const fileName of files) {
    const sourcePath = join(sourceDir, fileName);
    const targetPath = join(targetDir, fileName);
    const id = fileName.slice(0, -3);
    const alreadyExists = existsSync(targetPath);

    if (alreadyExists && !force) {
      skipped += 1;
      log(`skipped prompt '${id}' (${targetPath} already exists)`);
      continue;
    }

    copyFileSync(sourcePath, targetPath);
    installed += 1;
    log(`${alreadyExists && force ? "overwrote" : "installed"} prompt '${id}' -> ${targetPath}`);
  }

  return { installed, skipped };
}

function installSkills(args: {
  sourceDir: string;
  targetDir: string;
  force: boolean;
  selectedSkillName?: string;
  log: (message: string) => void;
}): InstallSummary {
  const { sourceDir, targetDir, force, selectedSkillName, log } = args;
  if (!existsSync(sourceDir)) {
    throw new InstallCliError(`starter skills directory not found: ${sourceDir}`);
  }

  const allEntries = readdirSync(sourceDir)
    .map((name) => ({ name, path: join(sourceDir, name) }))
    .filter((entry) => {
      try {
        return statSync(entry.path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  let entries = allEntries;
  if (selectedSkillName) {
    const selected = allEntries.find(
      (entry) => entry.name.toLowerCase() === selectedSkillName.toLowerCase(),
    );

    if (!selected) {
      const available = allEntries.map((entry) => entry.name).join(", ") || "(none)";
      throw new InstallCliError(
        `unknown starter skill '${selectedSkillName}'. available skills: ${available}`,
      );
    }

    entries = [selected];
  }

  if (entries.length === 0) {
    return { installed: 0, skipped: 0 };
  }

  mkdirSync(targetDir, { recursive: true });

  let installed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const targetPath = join(targetDir, entry.name);
    const alreadyExists = existsSync(targetPath);

    if (alreadyExists && !force) {
      skipped += 1;
      log(`skipped skill '${entry.name}' (${targetPath} already exists)`);
      continue;
    }

    if (alreadyExists && force) {
      rmSync(targetPath, { recursive: true, force: true });
    }

    cpSync(entry.path, targetPath, { recursive: true });
    installed += 1;
    log(
      `${alreadyExists && force ? "overwrote" : "installed"} skill '${entry.name}' -> ${targetPath}`,
    );
  }

  return { installed, skipped };
}

export function printInstallHelp(): void {
  console.log(
    [
      "usage:",
      "  tau install [options]",
      "",
      "options:",
      "  --global       install starter prompts and skills to ~/.config/tau.",
      "  --force        overwrite existing files and directories.",
      "  --prompt <id>  install only one starter prompt.",
      "  --skill <name> install only one starter skill.",
      "  --help         show this help and exit.",
      "",
      "default target:",
      "  .tau/ under the current working directory.",
      "",
      "notes:",
      "  --prompt and --skill are mutually exclusive.",
    ].join("\n"),
  );
}

export async function runInstallCommand(
  argv: string[],
  options?: InstallCommandOptions,
): Promise<void> {
  const parsed = parseInstallArgs(argv);
  if (parsed.help) {
    printInstallHelp();
    return;
  }

  const log = options?.log ?? console.log;
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.home ?? process.env.HOME ?? process.cwd();
  const starterContentRoot = options?.starterContentRoot ?? resolveStarterContentRoot();

  const targetRoot = parsed.global ? join(home, ".config", "tau") : join(cwd, ".tau");
  const promptsTargetDir = join(targetRoot, "prompts");
  const skillsTargetDir = join(targetRoot, "skills");

  let promptsSummary: InstallSummary | undefined;
  let skillsSummary: InstallSummary | undefined;

  if (parsed.promptId) {
    promptsSummary = installPrompts({
      sourceDir: join(starterContentRoot, "prompts"),
      targetDir: promptsTargetDir,
      force: parsed.force,
      selectedPromptId: parsed.promptId,
      log,
    });
  } else if (parsed.skillName) {
    skillsSummary = installSkills({
      sourceDir: join(starterContentRoot, "skills"),
      targetDir: skillsTargetDir,
      force: parsed.force,
      selectedSkillName: parsed.skillName,
      log,
    });
  } else {
    promptsSummary = installPrompts({
      sourceDir: join(starterContentRoot, "prompts"),
      targetDir: promptsTargetDir,
      force: parsed.force,
      log,
    });

    skillsSummary = installSkills({
      sourceDir: join(starterContentRoot, "skills"),
      targetDir: skillsTargetDir,
      force: parsed.force,
      log,
    });
  }

  const summaryLines: string[] = [];

  if (promptsSummary) {
    summaryLines.push(
      `installed ${promptsSummary.installed} prompt(s), skipped ${promptsSummary.skipped} prompt(s)`,
    );
  }

  if (skillsSummary) {
    summaryLines.push(
      `installed ${skillsSummary.installed} skill(s), skipped ${skillsSummary.skipped} skill(s)`,
    );
  }

  summaryLines.push(`target: ${targetRoot}`);

  log(summaryLines.join("\n"));
}
