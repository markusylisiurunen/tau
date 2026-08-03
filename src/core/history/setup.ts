import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithCapture } from "../utils/spawn_capture.js";

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
  const apiKey = options.apiKey?.trim() || env.TAU_HISTORY_API_KEY?.trim() || generateApiKey();
  const databaseId = await ensureDatabase(env, stdout);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tau-history-"));
  try {
    writeWorkerProject(temporaryDirectory, { domain, zoneName, databaseId });
    stdout(`deploying Worker ${WORKER_NAME} with Wrangler...`);
    await runWrangler(["deploy"], { cwd: temporaryDirectory, env });
    await runWrangler(["secret", "put", "API_KEY"], {
      cwd: temporaryDirectory,
      env,
      input: `${apiKey}\n`,
    });
    stdout(`deployed Worker ${WORKER_NAME}`);
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
    stdout("Set TAU_HISTORY_API_KEY to:");
    stdout(apiKey);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function destroyHistoryService(options: HistoryDestroyOptions): Promise<void> {
  if (!options.yes) throw new Error("tau history destroy requires --yes");
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? console.log;
  requireCloudflareAuth(env);

  const worker = await runWrangler(["delete", WORKER_NAME, "--force"], { env, allowFailure: true });
  stdout(worker.ok ? `deleted Worker ${WORKER_NAME}` : `Worker ${WORKER_NAME} was not deleted`);
  const database = await runWrangler(["d1", "delete", DATABASE_NAME, "--skip-confirmation"], {
    env,
    allowFailure: true,
  });
  stdout(
    database.ok
      ? `deleted D1 database ${DATABASE_NAME}`
      : `D1 database ${DATABASE_NAME} was not deleted`,
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

  const created = await runWrangler(["d1", "create", DATABASE_NAME, "--json"], { env });
  const parsed = JSON.parse(created.output) as D1DatabaseInfo;
  const id = databaseId(parsed);
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
          },
        ],
        ai: { binding: "AI" },
        triggers: { crons: ["*/30 * * * *"] },
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
