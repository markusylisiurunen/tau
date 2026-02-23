import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "../src/core/static/prompts");
const targetDir = join(__dirname, "../dist/core/static/prompts");

if (!existsSync(sourceDir)) {
  throw new Error(`static prompts source directory not found: ${sourceDir}`);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log("copied static prompts to dist/core/static/prompts");
