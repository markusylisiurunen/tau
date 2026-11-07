import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHistoryMigrations } from "../dist/core/history/setup.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src/history/worker/wrangler.dev.json");
const config = JSON.parse(readFileSync(source, "utf8"));
const directory = mkdtempSync(join(tmpdir(), "tau-history-dev-migrations-"));
try {
  writeFileSync(
    join(directory, "wrangler.json"),
    JSON.stringify({
      name: config.name,
      compatibility_date: config.compatibility_date,
      d1_databases: config.d1_databases,
    }),
  );
  await applyHistoryMigrations(directory, process.env, console.log, {
    databaseName: "tau-history-dev",
    remote: false,
    persistTo: join(root, "src/history/worker/.wrangler/state"),
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
