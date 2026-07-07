import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "../src/nook");
const targetDir = join(__dirname, "../dist/nook");

mkdirSync(targetDir, { recursive: true });
copyFileSync(join(sourceDir, "README.md"), join(targetDir, "README.md"));

console.log("copied nook assets to dist/nook");
