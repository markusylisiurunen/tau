import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "../package.json");
const versionFile = join(__dirname, "../src/version.ts");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const versionTs = `export const APP_VERSION = "${packageJson.version}";\n`;

writeFileSync(versionFile, versionTs);
console.log(`generated version file: ${packageJson.version}`);
