import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "../docs");
const targetDir = join(__dirname, "../dist/core/static/tau_docs");
const manifestPath = join(sourceDir, "manifest.json");
const maxDocumentBytes = 24 * 1024;

if (!existsSync(manifestPath)) {
  throw new Error(`Tau documentation manifest not found: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error("Tau documentation manifest must contain a non-empty files array");
}

const files = manifest.files;
const seen = new Set();
for (const file of files) {
  if (typeof file !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) {
    throw new Error(`Invalid Tau documentation path: ${String(file)}`);
  }
  if (seen.has(file)) {
    throw new Error(`Duplicate Tau documentation path: ${file}`);
  }
  seen.add(file);

  const sourcePath = join(sourceDir, file);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`Tau documentation file not found: ${sourcePath}`);
  }
  const bytes = statSync(sourcePath).size;
  if (bytes > maxDocumentBytes) {
    throw new Error(`Tau documentation file exceeds ${maxDocumentBytes} bytes: ${file}`);
  }
}

if (files[0] !== "index.md") {
  throw new Error("Tau documentation manifest must begin with index.md");
}

const sourceMarkdown = readdirSync(sourceDir, { recursive: true })
  .filter((file) => file.endsWith(".md"))
  .sort();
const unlisted = sourceMarkdown.filter((file) => !seen.has(file));
if (unlisted.length > 0) {
  throw new Error(`Unlisted Tau documentation files: ${unlisted.join(", ")}`);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}
mkdirSync(targetDir, { recursive: true });
cpSync(manifestPath, join(targetDir, "manifest.json"));
for (const file of files) {
  cpSync(join(sourceDir, file), join(targetDir, file));
}

console.log("copied Tau documentation to dist/core/static/tau_docs");
