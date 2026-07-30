import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "../src/core/static/code_mode");
const targetDir = join(__dirname, "../dist/core/static/code_mode");

if (!existsSync(sourceDir)) {
  throw new Error(`code-mode assets source directory not found: ${sourceDir}`);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log("copied code-mode assets to dist/core/static/code_mode");
