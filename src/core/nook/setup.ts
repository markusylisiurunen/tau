import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithCapture } from "../utils/spawn_capture.js";

const WORKER_NAME = "tau-nook";
const R2_BUCKET = "tau-nook-assets";

export type NookSetupArgs = {
  domain: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
};

export type NookDestroyArgs = NookSetupArgs & {
  yes: boolean;
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

function bundledWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../nook/worker/index.js");
}

function writeWranglerProject(tempDir: string, domain: string): void {
  const workerPath = bundledWorkerPath();
  const relativeWorker = relative(tempDir, workerPath).split("\\").join("/");
  const wranglerConfig = {
    name: WORKER_NAME,
    main: relativeWorker,
    compatibility_date: "2026-07-06",
    vars: {
      NOOK_DOMAIN: domain,
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
  writeFileSync(join(tempDir, "wrangler.json"), JSON.stringify(wranglerConfig, null, 2), "utf-8");
}

export async function runNookSetup(args: NookSetupArgs): Promise<void> {
  const env = args.env ?? process.env;
  const stdout = args.stdout ?? console.log;
  requireWranglerAuth(env);

  const tempDir = mkdtempSync(join(tmpdir(), "tau-nook-"));
  try {
    writeWranglerProject(tempDir, args.domain);
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
  requireWranglerAuth(env);

  try {
    await runWrangler(["delete", WORKER_NAME, "--force"], { env });
    stdout(`deleted Worker ${WORKER_NAME}`);
  } catch (error) {
    stdout(`Worker ${WORKER_NAME} was not deleted: ${(error as Error).message}`);
  }

  try {
    await runWrangler(["r2", "bucket", "delete", R2_BUCKET, "--force"], { env });
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
    domain: domain
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .toLowerCase(),
    remaining,
  };
}
