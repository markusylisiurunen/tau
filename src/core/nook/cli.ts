import { resolve } from "node:path";
import type { Config } from "../config/index.js";
import { createNookClientFromConfig } from "./client.js";
import { buildNookDeployManifest, buildNookTemplateManifest } from "./deploy.js";
import {
  parseNookDestroyInputs,
  parseNookSetupInputs,
  runNookDestroy,
  runNookSetup,
} from "./setup.js";

export class NookCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NookCliError";
  }
}

export type RunNookCommandOptions = {
  config: Config;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

function parseValue(
  arg: string,
  argv: string[],
  index: number,
): { value: string; nextIndex: number } {
  const eqIndex = arg.indexOf("=");
  if (eqIndex !== -1) {
    const value = arg.slice(eqIndex + 1);
    if (!value) throw new NookCliError(`missing value for ${arg.slice(0, eqIndex)}`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new NookCliError(`missing value for ${arg}`);
  }
  return { value, nextIndex: index + 1 };
}

export function printNookHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau nook setup --domain <domain> --zone-name <zone> --access-team-domain <url> --access-aud <aud>",
      "  tau nook destroy --domain <domain> --access-client-id <id> --access-client-secret <secret> --yes",
      "  tau nook skill",
      "  tau nook deploy <dir> --site <slug> [--public]",
      "  tau nook copy <site> <dir>",
      "  tau nook list",
      "  tau nook delete <site>",
      "  tau nook template list",
      "  tau nook template copy <name> <dir>",
      "  tau nook template save <name> <dir>",
      "  tau nook template delete <name>",
      "  tau nook kv get <site> <key>",
      "  tau nook kv put <site> <key> <json>",
      "  tau nook kv delete <site> <key>",
      "  tau nook kv list <site> [--prefix <prefix>]",
    ].join("\n"),
  );
}

export async function runNookCommand(
  argv: string[],
  options: RunNookCommandOptions,
): Promise<void> {
  const stdout = options.stdout ?? console.log;
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printNookHelp(stdout);
    return;
  }

  try {
    if (subcommand === "setup") {
      const parsed = parseNookSetupInputs({ argv: args, env: options.env });
      if (parsed.remaining.length > 0) throw new Error(`unknown option: ${parsed.remaining[0]}`);
      await runNookSetup({
        domain: parsed.domain,
        zoneName: parsed.zoneName,
        accessTeamDomain: parsed.accessTeamDomain,
        accessAud: parsed.accessAud,
        env: options.env,
        stdout,
      });
      return;
    }

    if (subcommand === "destroy") {
      const parsed = parseNookDestroyInputs({ argv: args, env: options.env });
      if (parsed.remaining.length > 0) throw new Error(`unknown option: ${parsed.remaining[0]}`);
      await runNookDestroy({
        domain: parsed.domain,
        accessClientId: parsed.accessClientId,
        accessClientSecret: parsed.accessClientSecret,
        yes: parsed.yes,
        env: options.env,
        stdout,
        fetchImpl: options.fetchImpl,
      });
      return;
    }

    const client = createNookClientFromConfig({
      config: options.config,
      env: options.env,
      fetchImpl: options.fetchImpl,
    });

    if (subcommand === "skill") {
      stdout(await client.readSkill());
      return;
    }

    if (subcommand === "list") {
      const sites = await client.listSites();
      if (sites.length === 0) {
        stdout("no nook sites");
        return;
      }
      for (const site of sites) {
        const visibility = site.visibility ? ` ${site.visibility}` : "";
        const latest = site.latestDeploymentId ? ` ${site.latestDeploymentId}` : "";
        stdout(`${site.slug} ${site.url}${visibility}${latest}`.trim());
      }
      return;
    }

    if (subcommand === "delete") {
      const site = args[0];
      if (!site || args.length !== 1) throw new Error("usage: tau nook delete <site>");
      await client.deleteSite(site);
      stdout(`deleted ${site}`);
      return;
    }

    if (subcommand === "copy") {
      const [site, directory] = args;
      if (!site || !directory || args.length !== 2) {
        throw new Error("usage: tau nook copy <site> <dir>");
      }
      const result = await client.copySiteToDirectory(
        site,
        resolve(options.cwd ?? process.cwd(), directory),
      );
      stdout(`copied site ${result.site} to ${directory}`);
      return;
    }

    if (subcommand === "deploy") {
      let site: string | undefined;
      let isPublic = false;
      const positional: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        if (arg === "--public") {
          isPublic = true;
          continue;
        }
        if (arg === "--site" || arg.startsWith("--site=")) {
          const parsed = parseValue(arg, args, i);
          site = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        positional.push(arg);
      }
      if (positional.length !== 1 || !site) {
        throw new Error("usage: tau nook deploy <dir> --site <slug> [--public]");
      }
      const files = buildNookDeployManifest(resolve(options.cwd ?? process.cwd(), positional[0]!));
      const result = await client.deploySite({
        site,
        files,
        visibility: isPublic ? "public" : "private",
      });
      stdout(`Deployed ${result.site} to ${result.url}`);
      return;
    }

    if (subcommand === "template") {
      await runTemplateCommand(args, client, stdout, options.cwd ?? process.cwd());
      return;
    }

    if (subcommand === "kv") {
      await runKvCommand(args, client, stdout);
      return;
    }

    throw new Error(`unknown nook subcommand '${subcommand}'`);
  } catch (error) {
    throw new NookCliError(error instanceof Error ? error.message : String(error));
  }
}

async function runTemplateCommand(
  args: string[],
  client: ReturnType<typeof createNookClientFromConfig>,
  stdout: (line: string) => void,
  cwd: string,
): Promise<void> {
  const [operation, name, directory] = args;
  if (!operation) throw new Error("missing template operation");

  if (operation === "list") {
    if (args.length !== 1) throw new Error("usage: tau nook template list");
    const templates = await client.listTemplates();
    if (templates.length === 0) {
      stdout("no nook templates");
      return;
    }
    for (const template of templates) {
      stdout(
        `${template.name} ${template.fileCount} files ${template.byteCount}B ${template.updatedAt}`,
      );
    }
    return;
  }

  if (operation === "copy") {
    if (!name || !directory || args.length !== 3) {
      throw new Error("usage: tau nook template copy <name> <dir>");
    }
    const result = await client.copyTemplateToDirectory(name, resolve(cwd, directory));
    stdout(`copied template ${result.name} to ${directory}`);
    return;
  }

  if (operation === "save") {
    if (!name || !directory || args.length !== 3) {
      throw new Error("usage: tau nook template save <name> <dir>");
    }
    const files = buildNookTemplateManifest(resolve(cwd, directory));
    const result = await client.saveTemplate({ name, files });
    stdout(`saved template ${result.name} (${result.fileCount} files)`);
    return;
  }

  if (operation === "delete") {
    if (!name || args.length !== 2) throw new Error("usage: tau nook template delete <name>");
    await client.deleteTemplate(name);
    stdout(`deleted template ${name}`);
    return;
  }

  throw new Error(`unknown template operation '${operation}'`);
}

async function runKvCommand(
  args: string[],
  client: ReturnType<typeof createNookClientFromConfig>,
  stdout: (line: string) => void,
): Promise<void> {
  const [operation, site, keyOrFlag, value] = args;
  if (!operation) throw new Error("missing kv operation");

  if (operation === "get") {
    if (!site || !keyOrFlag || args.length !== 3)
      throw new Error("usage: tau nook kv get <site> <key>");
    stdout(JSON.stringify(await client.getKv(site, keyOrFlag), null, 2));
    return;
  }

  if (operation === "put") {
    if (!site || !keyOrFlag || value === undefined || args.length !== 4) {
      throw new Error("usage: tau nook kv put <site> <key> <json>");
    }
    await client.putKv(site, keyOrFlag, JSON.parse(value));
    stdout(`stored ${site}/${keyOrFlag}`);
    return;
  }

  if (operation === "delete") {
    if (!site || !keyOrFlag || args.length !== 3) {
      throw new Error("usage: tau nook kv delete <site> <key>");
    }
    await client.deleteKv(site, keyOrFlag);
    stdout(`deleted ${site}/${keyOrFlag}`);
    return;
  }

  if (operation === "list") {
    if (!site) throw new Error("usage: tau nook kv list <site> [--prefix <prefix>]");
    let prefix: string | undefined;
    for (let i = 2; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--prefix" || arg.startsWith("--prefix=")) {
        const parsed = parseValue(arg, args, i);
        prefix = parsed.value;
        i = parsed.nextIndex;
        continue;
      }
      throw new Error(`unknown option: ${arg}`);
    }
    const result = await client.listKv(site, prefix);
    for (const entry of result.keys) {
      stdout(`${entry.key} ${entry.sizeBytes}B ${entry.updatedAt}`);
    }
    return;
  }

  throw new Error(`unknown kv operation '${operation}'`);
}
