import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { normalizeNookDomain } from "./validation.js";

const WORKER_NAME = "tau-nook";
const R2_BUCKET = "tau-nook-assets";

export type NookSetupArgs = {
  domain: string;
  accessTeamDomain: string;
  accessAud: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
};

export type NookDestroyArgs = {
  domain: string;
  yes: boolean;
  accessClientId: string;
  accessClientSecret: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

async function runWrangler(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const result = await spawnWithCapture("wrangler", args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    captureOutput: "combined-and-split",
    maxCaptureBytes: 1024 * 1024,
    maxCaptureMode: "ignore",
    maxCaptureStrategy: "tail",
  });
  if (result.exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.output}`);
  }
  return (result.output ?? "").trim();
}

function requireWranglerAuth(env: NodeJS.ProcessEnv): void {
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required for non-interactive wrangler auth.");
  }
}

function normalizeAccessTeamDomain(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Cloudflare Access team domain must be an HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Cloudflare Access team domain must be an HTTPS origin URL.");
  }
  return url.origin;
}

function bundledWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../nook/worker/index.js");
}

function writeWranglerProject(args: {
  tempDir: string;
  domain: string;
  accessTeamDomain: string;
  accessAud: string;
}): void {
  const workerPath = bundledWorkerPath();
  const relativeWorker = relative(args.tempDir, workerPath).split("\\").join("/");
  const wranglerConfig = {
    name: WORKER_NAME,
    main: relativeWorker,
    compatibility_date: "2026-07-06",
    workers_dev: false,
    vars: {
      NOOK_DOMAIN: args.domain,
      NOOK_ACCESS_TEAM_DOMAIN: args.accessTeamDomain,
      NOOK_ACCESS_AUD: args.accessAud,
    },
    r2_buckets: [
      {
        binding: "ASSETS",
        bucket_name: R2_BUCKET,
      },
    ],
    durable_objects: {
      bindings: [
        { name: "REGISTRY_DO", class_name: "RegistryDO" },
        { name: "SITE_DO", class_name: "SiteDO" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["RegistryDO", "SiteDO"],
      },
    ],
  };
  writeFileSync(
    join(args.tempDir, "wrangler.json"),
    JSON.stringify(wranglerConfig, null, 2),
    "utf-8",
  );
}

export async function runNookSetup(args: NookSetupArgs): Promise<void> {
  const env = args.env ?? process.env;
  const stdout = args.stdout ?? console.log;
  requireWranglerAuth(env);

  const tempDir = mkdtempSync(join(tmpdir(), "tau-nook-"));
  try {
    writeWranglerProject({
      tempDir,
      domain: args.domain,
      accessTeamDomain: args.accessTeamDomain,
      accessAud: args.accessAud,
    });
    try {
      await runWrangler(["r2", "bucket", "create", R2_BUCKET], { env });
      stdout(`created R2 bucket ${R2_BUCKET}`);
    } catch (error) {
      stdout(
        `R2 bucket ${R2_BUCKET} already exists or could not be created: ${(error as Error).message}`,
      );
    }

    await runWrangler(["deploy"], { cwd: tempDir, env });
    stdout(`deployed Worker ${WORKER_NAME}`);
    stdout("");
    stdout("Configure DNS/routes for:");
    stdout(`  ${args.domain}`);
    stdout(`  *.${args.domain}`);
    stdout("");
    stdout("Configure Cloudflare Access for both hostnames with application audience:");
    stdout(`  ${args.accessAud}`);
    stdout("");
    stdout("Add this to Tau config after creating a Cloudflare Access service token:");
    stdout(
      JSON.stringify(
        {
          nook: {
            domain: args.domain,
            accessClientId: "<cloudflare-access-client-id>",
            accessClientSecretEnv: "NOOK_ACCESS_CLIENT_SECRET",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runNookDestroy(args: NookDestroyArgs): Promise<void> {
  if (!args.yes) {
    throw new Error("tau nook destroy requires --yes.");
  }

  const env = args.env ?? process.env;
  const stdout = args.stdout ?? console.log;
  const fetchImpl = args.fetchImpl ?? fetch;
  requireWranglerAuth(env);

  try {
    const cleanupResponse = await fetchImpl(`https://${args.domain}/__nook/api/destroy`, {
      method: "POST",
      headers: {
        "CF-Access-Client-Id": args.accessClientId,
        "CF-Access-Client-Secret": args.accessClientSecret,
      },
    });
    if (!cleanupResponse.ok) {
      throw new Error(await cleanupResponse.text());
    }
    stdout(`deleted Nook R2 objects and Durable Object data for ${args.domain}`);
  } catch (error) {
    throw new Error(
      `failed to clean up Nook data through https://${args.domain}/__nook/api/destroy: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    await runWrangler(["delete", WORKER_NAME, "--force"], { env });
    stdout(`deleted Worker ${WORKER_NAME}`);
  } catch (error) {
    stdout(`Worker ${WORKER_NAME} was not deleted: ${(error as Error).message}`);
  }

  try {
    await runWrangler(["r2", "bucket", "delete", R2_BUCKET], { env });
    stdout(`deleted R2 bucket ${R2_BUCKET}`);
  } catch (error) {
    stdout(`R2 bucket ${R2_BUCKET} was not deleted: ${(error as Error).message}`);
  }
}

export function parseNookInfrastructureDomain(args: { argv: string[]; env?: NodeJS.ProcessEnv }): {
  domain: string;
  remaining: string[];
} {
  const remaining: string[] = [];
  let domain = args.env?.NOOK_DOMAIN;

  for (let i = 0; i < args.argv.length; i += 1) {
    const arg = args.argv[i]!;
    if (arg === "--domain" || arg.startsWith("--domain=")) {
      const value = arg.includes("=") ? arg.slice("--domain=".length) : args.argv[++i];
      if (!value) {
        throw new Error("missing value for --domain");
      }
      domain = value;
      continue;
    }
    remaining.push(arg);
  }

  if (!domain?.trim()) {
    throw new Error("missing nook domain. pass --domain <domain> or set NOOK_DOMAIN.");
  }

  return {
    domain: normalizeNookDomain(domain),
    remaining,
  };
}

export function parseNookSetupInputs(args: { argv: string[]; env?: NodeJS.ProcessEnv }): {
  domain: string;
  accessTeamDomain: string;
  accessAud: string;
  remaining: string[];
} {
  const parsedDomain = parseNookInfrastructureDomain({ argv: args.argv, env: args.env });
  const remaining: string[] = [];
  let accessTeamDomain = args.env?.NOOK_ACCESS_TEAM_DOMAIN;
  let accessAud = args.env?.NOOK_ACCESS_AUD;

  for (let i = 0; i < parsedDomain.remaining.length; i += 1) {
    const arg = parsedDomain.remaining[i]!;
    if (arg === "--access-team-domain" || arg.startsWith("--access-team-domain=")) {
      const value = arg.includes("=")
        ? arg.slice("--access-team-domain=".length)
        : parsedDomain.remaining[++i];
      if (!value) throw new Error("missing value for --access-team-domain");
      accessTeamDomain = value;
      continue;
    }
    if (arg === "--access-aud" || arg.startsWith("--access-aud=")) {
      const value = arg.includes("=")
        ? arg.slice("--access-aud=".length)
        : parsedDomain.remaining[++i];
      if (!value) throw new Error("missing value for --access-aud");
      accessAud = value;
      continue;
    }
    remaining.push(arg);
  }

  if (!accessTeamDomain?.trim()) {
    throw new Error(
      "missing Cloudflare Access team domain. pass --access-team-domain <url> or set NOOK_ACCESS_TEAM_DOMAIN.",
    );
  }
  if (!accessAud?.trim()) {
    throw new Error(
      "missing Cloudflare Access application audience. pass --access-aud <aud> or set NOOK_ACCESS_AUD.",
    );
  }

  return {
    domain: parsedDomain.domain,
    accessTeamDomain: normalizeAccessTeamDomain(accessTeamDomain),
    accessAud: accessAud.trim(),
    remaining,
  };
}

export function parseNookDestroyInputs(args: { argv: string[]; env?: NodeJS.ProcessEnv }): {
  domain: string;
  accessClientId: string;
  accessClientSecret: string;
  yes: boolean;
  remaining: string[];
} {
  const parsedDomain = parseNookInfrastructureDomain({ argv: args.argv, env: args.env });
  const remaining: string[] = [];
  let accessClientId = args.env?.NOOK_ACCESS_CLIENT_ID;
  let accessClientSecret = args.env?.NOOK_ACCESS_CLIENT_SECRET;
  let yes = false;

  for (let i = 0; i < parsedDomain.remaining.length; i += 1) {
    const arg = parsedDomain.remaining[i]!;
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--access-client-id" || arg.startsWith("--access-client-id=")) {
      const value = arg.includes("=")
        ? arg.slice("--access-client-id=".length)
        : parsedDomain.remaining[++i];
      if (!value) throw new Error("missing value for --access-client-id");
      accessClientId = value;
      continue;
    }
    if (arg === "--access-client-secret" || arg.startsWith("--access-client-secret=")) {
      const value = arg.includes("=")
        ? arg.slice("--access-client-secret=".length)
        : parsedDomain.remaining[++i];
      if (!value) throw new Error("missing value for --access-client-secret");
      accessClientSecret = value;
      continue;
    }
    remaining.push(arg);
  }

  if (!accessClientId?.trim()) {
    throw new Error(
      "missing Cloudflare Access client id. pass --access-client-id <id> or set NOOK_ACCESS_CLIENT_ID.",
    );
  }
  if (!accessClientSecret?.trim()) {
    throw new Error(
      "missing Cloudflare Access client secret. pass --access-client-secret <secret> or set NOOK_ACCESS_CLIENT_SECRET.",
    );
  }

  return {
    domain: parsedDomain.domain,
    accessClientId: accessClientId.trim(),
    accessClientSecret: accessClientSecret.trim(),
    yes,
    remaining,
  };
}
