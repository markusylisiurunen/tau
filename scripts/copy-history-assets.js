import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "../src/history/worker/migrations");
const targetDir = join(__dirname, "../dist/history/worker/migrations");

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log("copied history Worker migrations to dist/history/worker/migrations");
