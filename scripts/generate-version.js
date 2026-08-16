import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "../package.json");
const versionFile = join(__dirname, "../src/core/version.ts");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const piAiVersion = packageJson.dependencies["@earendil-works/pi-ai"];
if (typeof piAiVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(piAiVersion)) {
  throw new Error("@earendil-works/pi-ai must use an exact version");
}
const versionTs = [
  `export const APP_VERSION = "${packageJson.version}";`,
  `export const PI_AI_VERSION = "${piAiVersion}";`,
  "",
].join("\n");

writeFileSync(versionFile, versionTs);
console.log(`generated versions: tau ${packageJson.version}, pi-ai ${piAiVersion}`);
