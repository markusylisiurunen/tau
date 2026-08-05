import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { HISTORY_INITIAL_MIGRATION_NAME, HISTORY_INITIAL_MIGRATION_SQL } from "./migrations.js";

const WORKER_NAME = "tau-history";
const DATABASE_NAME = "tau-history";
const MAX_CAPTURE_BYTES = 1024 * 1024;

export type HistorySetupOptions = {
  domain: string;
  zoneName: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
};

export type HistoryDestroyOptions = {
  yes: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
};

type D1DatabaseInfo = {
  name?: unknown;
  uuid?: unknown;
  id?: unknown;
  database_id?: unknown;
  d1_databases?: unknown;
};

export async function setupHistoryService(options: HistorySetupOptions): Promise<void> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? console.log;
  requireCloudflareAuth(env);
  const domain = normalizeDomain(options.domain);
  const zoneName = options.zoneName.trim();
  if (!zoneName) throw new Error("zone name is required");
  const suppliedApiKey = options.apiKey?.trim() || env.TAU_HISTORY_API_KEY?.trim();
  const apiKey = suppliedApiKey || generateApiKey();
  const databaseId = await ensureDatabase(env, stdout);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tau-history-"));
  try {
    writeWorkerProject(temporaryDirectory, { domain, zoneName, databaseId });
    await applyHistoryMigrations(temporaryDirectory, env, stdout);
    stdout(`deploying Worker ${WORKER_NAME} with Wrangler...`);
    await runWrangler(["deploy"], { cwd: temporaryDirectory, env });
    await runWrangler(["secret", "put", "API_KEY"], {
      cwd: temporaryDirectory,
      env,
      input: `${apiKey}\n`,
    });
    stdout(`deployed Worker ${WORKER_NAME}`);
    stdout("");
    stdout("The shared history service requires the Cloudflare Workers Paid plan.");
    stdout("");
    stdout("Add this to the global Tau config:");
    stdout(
      JSON.stringify(
        {
          history: {
            endpoint: `https://${domain}`,
            apiKeyEnv: "TAU_HISTORY_API_KEY",
          },
        },
        null,
        2,
      ),
    );
    stdout("");
    if (suppliedApiKey) {
      stdout("Set TAU_HISTORY_API_KEY to the API key supplied for this deployment.");
    } else {
      stdout("Set TAU_HISTORY_API_KEY to:");
      stdout(apiKey);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function destroyHistoryService(options: HistoryDestroyOptions): Promise<void> {
  if (!options.yes) throw new Error("tau history destroy requires --yes");
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? console.log;
  requireCloudflareAuth(env);

  const failures: Error[] = [];
  const resources = [
    { label: `Worker ${WORKER_NAME}`, args: ["delete", "--name", WORKER_NAME] },
    {
      label: `D1 database ${DATABASE_NAME}`,
      args: ["d1", "delete", DATABASE_NAME, "--skip-confirmation"],
    },
  ];
  for (const resource of resources) {
    try {
      const result = await runWrangler(resource.args, { env, allowFailure: true });
      if (result.ok) {
        stdout(`deleted ${resource.label}`);
      } else if (isMissingHistoryResource(result.output)) {
        stdout(`${resource.label} was already absent`);
      } else {
        const failure = new Error(
          `wrangler ${resource.args.join(" ")} failed${result.output ? `:\n${result.output}` : " without diagnostic output"}`,
        );
        failures.push(failure);
        stdout(`${resource.label} was not deleted: ${failure.message}`);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      stdout(`${resource.label} was not deleted: ${failure.message}`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `failed to destroy history service:\n${failures.map((failure) => failure.message).join("\n")}`,
    );
  }
}

function isMissingHistoryResource(output: string): boolean {
  const normalized = output.toLowerCase();
  if (!normalized.includes("tau-history")) return false;
  return ["not found", "does not exist", "could not find", "couldn't find"].some((phrase) =>
    normalized.includes(phrase),
  );
}

async function ensureDatabase(
  env: NodeJS.ProcessEnv,
  stdout: (line: string) => void,
): Promise<string> {
  const listed = await runWrangler(["d1", "list", "--json"], { env });
  const databases = JSON.parse(listed.output) as D1DatabaseInfo[];
  const existing = databases.find((database) => database.name === DATABASE_NAME);
  if (existing) {
    const id = databaseId(existing);
    stdout(`D1 database ${DATABASE_NAME} already exists`);
    return id;
  }

  await runWrangler(["d1", "create", DATABASE_NAME], { env });
  const info = await runWrangler(["d1", "info", DATABASE_NAME, "--json"], { env });
  const id = databaseId(JSON.parse(info.output) as D1DatabaseInfo);
  stdout(`created D1 database ${DATABASE_NAME}`);
  return id;
}

function databaseId(database: D1DatabaseInfo): string {
  const direct = [database.uuid, database.id, database.database_id].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (direct) return direct;
  if (Array.isArray(database.d1_databases) && database.d1_databases.length > 0) {
    const nested = database.d1_databases[0];
    if (typeof nested === "object" && nested !== null) {
      return databaseId(nested as D1DatabaseInfo);
    }
  }
  throw new Error("Wrangler returned D1 database data without an ID");
}

async function applyHistoryMigrations(
  directory: string,
  env: NodeJS.ProcessEnv,
  stdout: (line: string) => void,
): Promise<void> {
  stdout(`applying D1 migrations for ${DATABASE_NAME}...`);
  await runWrangler(["d1", "migrations", "apply", DATABASE_NAME, "--remote"], {
    cwd: directory,
    env,
  });
  stdout(`applied D1 migrations for ${DATABASE_NAME}`);
}

function writeHistoryMigration(directory: string): void {
  const migrationsDirectory = join(directory, "migrations");
  mkdirSync(migrationsDirectory, { recursive: true });
  writeFileSync(
    join(migrationsDirectory, HISTORY_INITIAL_MIGRATION_NAME),
    HISTORY_INITIAL_MIGRATION_SQL,
    "utf8",
  );
}

function writeWorkerProject(
  directory: string,
  options: { domain: string; zoneName: string; databaseId: string },
): void {
  const workerPath = fileURLToPath(new URL("../../history/worker/index.js", import.meta.url));
  if (!existsSync(workerPath)) {
    throw new Error(`bundled history Worker is missing at ${workerPath}; rebuild or reinstall Tau`);
  }
  const destination = join(directory, "worker", "index.js");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(workerPath, destination);
  writeHistoryMigration(directory);
  writeFileSync(
    join(directory, "wrangler.json"),
    JSON.stringify(
      {
        name: WORKER_NAME,
        main: "worker/index.js",
        compatibility_date: "2026-08-01",
        workers_dev: false,
        routes: [{ pattern: `${options.domain}/*`, zone_name: options.zoneName }],
        d1_databases: [
          {
            binding: "DB",
            database_name: DATABASE_NAME,
            database_id: options.databaseId,
            migrations_dir: "migrations",
          },
        ],
        ai: { binding: "AI" },
        observability: { enabled: true },
        triggers: { crons: ["* * * * *"] },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function runWrangler(
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    allowFailure?: boolean;
  },
): Promise<{ ok: boolean; output: string }> {
  const result = await spawnWithCapture("wrangler", args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    captureOutput: "combined",
    maxCaptureBytes: MAX_CAPTURE_BYTES,
    maxCaptureMode: "ignore",
    maxCaptureStrategy: "tail",
  });
  const output = (result.output ?? "").trim();
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${output}`);
  }
  return { ok: result.exitCode === 0, output };
}

function normalizeDomain(value: string): string {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!domain || domain.includes("/") || domain.includes(":") || !domain.includes(".")) {
    throw new Error("history domain must be a DNS hostname without a path");
  }
  return domain;
}

function requireCloudflareAuth(env: NodeJS.ProcessEnv): void {
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required for non-interactive Wrangler auth");
  }
}

function generateApiKey(): string {
  return randomBytes(32).toString("base64url");
}
