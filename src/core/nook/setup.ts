import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { truncateToBytesFromEnd } from "../utils/truncate.js";
import { normalizeNookDomain } from "./validation.js";

const WORKER_NAME = "tau-nook";
const R2_BUCKET = "tau-nook-assets";

export type NookSetupArgs = {
  domain: string;
  zoneName: string;
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

const COMMAND_OUTPUT_CAPTURE_BYTES = 1024 * 1024;

type RunWranglerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type StreamWranglerOptions = RunWranglerOptions & {
  stdout: (line: string) => void;
};

type RunWranglerResult = {
  output: string;
  exitCode: number | null;
};

type StreamWranglerState = {
  pendingLine: string;
  output: string;
};

function appendWranglerOutput(state: StreamWranglerState, text: string): void {
  if (!text) return;

  state.output += text;
  if (Buffer.byteLength(state.output, "utf-8") > COMMAND_OUTPUT_CAPTURE_BYTES) {
    state.output = truncateToBytesFromEnd(state.output, COMMAND_OUTPUT_CAPTURE_BYTES);
  }
}

function streamWranglerText(
  text: string,
  state: StreamWranglerState,
  stdout: (line: string) => void,
): void {
  if (!text) return;

  appendWranglerOutput(state, text);
  state.pendingLine += text;
  const parts = state.pendingLine.split(/\r\n|\n|\r/);
  state.pendingLine = parts.pop() ?? "";
  for (const part of parts) {
    stdout(part);
  }
}

async function runWranglerCaptured(
  args: string[],
  options: RunWranglerOptions = {},
): Promise<RunWranglerResult> {
  const result = await spawnWithCapture("wrangler", args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    captureOutput: "combined",
    maxCaptureBytes: COMMAND_OUTPUT_CAPTURE_BYTES,
    maxCaptureMode: "ignore",
    maxCaptureStrategy: "tail",
  });
  return { output: (result.output ?? "").trim(), exitCode: result.exitCode };
}

function streamWrangler(
  args: string[],
  options: StreamWranglerOptions,
): Promise<RunWranglerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const streamState: StreamWranglerState = { pendingLine: "", output: "" };
    let settled = false;

    child.stdout?.on("data", (chunk) =>
      streamWranglerText(stdoutDecoder.write(chunk as Buffer), streamState, options.stdout),
    );
    child.stderr?.on("data", (chunk) =>
      streamWranglerText(stderrDecoder.write(chunk as Buffer), streamState, options.stdout),
    );

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      streamWranglerText(stdoutDecoder.end(), streamState, options.stdout);
      streamWranglerText(stderrDecoder.end(), streamState, options.stdout);
      if (streamState.pendingLine) {
        options.stdout(streamState.pendingLine);
      }
      resolve({ output: streamState.output.trim(), exitCode });
    });
  });
}

async function runWrangler(args: string[], options: RunWranglerOptions = {}): Promise<string> {
  const result = await runWranglerCaptured(args, options);
  if (result.exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output;
}

async function runWranglerStreaming(
  args: string[],
  options: StreamWranglerOptions,
): Promise<string> {
  const result = await streamWrangler(args, options);
  if (result.exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output;
}

async function runNpmInstall(options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const result = await spawnWithCapture(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      captureOutput: "combined",
      maxCaptureBytes: COMMAND_OUTPUT_CAPTURE_BYTES,
      maxCaptureMode: "ignore",
      maxCaptureStrategy: "tail",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`npm install failed while preparing bundled Nook Worker:\n${result.output}`);
  }
}

type WranglerR2BucketInfo = {
  name: string;
};

function parseWranglerR2BucketInfo(output: string): WranglerR2BucketInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`wrangler r2 bucket info returned invalid JSON:\n${output}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { name?: unknown }).name !== "string"
  ) {
    throw new Error(`wrangler r2 bucket info returned unexpected JSON:\n${output}`);
  }

  return parsed as WranglerR2BucketInfo;
}

function isMissingR2BucketOutput(output: string): boolean {
  return (
    output.includes("10007") ||
    /bucket.*(?:does not exist|not found)|(?:does not exist|not found).*bucket/i.test(output)
  );
}

async function readExistingR2BucketInfo(
  env?: NodeJS.ProcessEnv,
): Promise<WranglerR2BucketInfo | undefined> {
  const result = await runWranglerCaptured(["r2", "bucket", "info", R2_BUCKET, "--json"], { env });
  if (result.exitCode !== 0) {
    if (isMissingR2BucketOutput(result.output)) return undefined;
    throw new Error(`wrangler r2 bucket info ${R2_BUCKET} failed:\n${result.output}`);
  }

  const info = parseWranglerR2BucketInfo(result.output);
  if (info.name !== R2_BUCKET) {
    throw new Error(
      `wrangler r2 bucket info returned bucket '${info.name}' while checking '${R2_BUCKET}'.`,
    );
  }
  return info;
}

async function ensureR2Bucket(args: {
  env?: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
}): Promise<void> {
  const existing = await readExistingR2BucketInfo(args.env);
  if (existing) {
    args.stdout(`R2 bucket ${existing.name} already exists`);
    return;
  }

  await runWrangler(["r2", "bucket", "create", R2_BUCKET], { env: args.env });
  args.stdout(`created R2 bucket ${R2_BUCKET}`);
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

function packageRootPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function nookWorkerDependencies(): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(join(packageRootPath(), "package.json"), "utf-8"),
  ) as { dependencies?: Record<string, string> };
  const jose = packageJson.dependencies?.jose;
  if (!jose) {
    throw new Error("Tau package is missing required Nook Worker dependency 'jose'.");
  }
  return { jose };
}

function writeBundledWorkerProject(tempDir: string): void {
  const workerPath = bundledWorkerPath();
  if (!existsSync(workerPath)) {
    throw new Error(
      `bundled Nook Worker is missing at ${workerPath}. Rebuild or reinstall Tau before running tau nook setup.`,
    );
  }

  const workerDir = join(tempDir, "worker");
  mkdirSync(workerDir, { recursive: true });
  copyFileSync(workerPath, join(workerDir, "index.js"));

  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: nookWorkerDependencies(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeWranglerProject(args: {
  tempDir: string;
  domain: string;
  zoneName: string;
  accessTeamDomain: string;
  accessAud: string;
}): void {
  writeBundledWorkerProject(args.tempDir);
  const wranglerConfig = {
    name: WORKER_NAME,
    main: "worker/index.js",
    compatibility_date: "2026-07-06",
    workers_dev: false,
    routes: [{ pattern: `${args.domain}/*`, zone_name: args.zoneName }],
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
      zoneName: args.zoneName,
      accessTeamDomain: args.accessTeamDomain,
      accessAud: args.accessAud,
    });
    await runNpmInstall({ cwd: tempDir, env });
    await ensureR2Bucket({ env, stdout });

    stdout(`deploying Worker ${WORKER_NAME} with Wrangler...`);
    await runWranglerStreaming(["deploy"], { cwd: tempDir, env, stdout });
    stdout(`deployed Worker ${WORKER_NAME}`);
    stdout("");
    stdout("Configure DNS for:");
    stdout(`  ${args.domain}`);
    stdout("");
    stdout("Configure Cloudflare Access for this hostname with application audience:");
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
  zoneName: string;
  accessTeamDomain: string;
  accessAud: string;
  remaining: string[];
} {
  const parsedDomain = parseNookInfrastructureDomain({ argv: args.argv, env: args.env });
  const remaining: string[] = [];
  let zoneName = args.env?.NOOK_ZONE_NAME;
  let accessTeamDomain = args.env?.NOOK_ACCESS_TEAM_DOMAIN;
  let accessAud = args.env?.NOOK_ACCESS_AUD;

  for (let i = 0; i < parsedDomain.remaining.length; i += 1) {
    const arg = parsedDomain.remaining[i]!;
    if (arg === "--zone-name" || arg.startsWith("--zone-name=")) {
      const value = arg.includes("=")
        ? arg.slice("--zone-name=".length)
        : parsedDomain.remaining[++i];
      if (!value) throw new Error("missing value for --zone-name");
      zoneName = value;
      continue;
    }
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

  if (!zoneName?.trim()) {
    throw new Error("missing Cloudflare zone name. pass --zone-name <zone> or set NOOK_ZONE_NAME.");
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
    zoneName: normalizeNookDomain(zoneName),
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
