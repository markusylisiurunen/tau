import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterAll } from "vitest";

if (!isMainThread) {
  throw new Error("tests require forked workers to isolate native environment state");
}

const previousHome = process.env.HOME;
const previousOffline = process.env.TAU_OFFLINE;
const originalFetch = globalThis.fetch;
const home = mkdtempSync(join(tmpdir(), "tau-test-home-"));
process.env.HOME = home;
if (homedir() !== home) {
  throw new Error("test HOME must also isolate native filesystem access");
}
process.env.TAU_OFFLINE = "1";

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`tests must stub external HTTP requests: ${url.origin}`);
  }
  return await originalFetch(input, init);
};

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousOffline === undefined) delete process.env.TAU_OFFLINE;
  else process.env.TAU_OFFLINE = previousOffline;
  await rm(home, { recursive: true, force: true });
});
