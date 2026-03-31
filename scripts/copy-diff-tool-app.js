import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "../src/diff_tool/app/dist");
const targetDir = join(__dirname, "../dist/diff_tool/app/dist");

if (!existsSync(sourceDir)) {
  throw new Error(
    `diff tool app build not found: ${sourceDir} (run "(cd src/diff_tool/app && npm run build)" first)`,
  );
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log("copied diff tool app to dist/diff_tool/app/dist");
