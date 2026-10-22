import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  entryPoints: [
    fileURLToPath(new URL("../src/core/subagents/claude_code_runner.ts", import.meta.url)),
  ],
  outfile: fileURLToPath(new URL("../dist/core/subagents/claude_code_runner.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
  },
  target: "node24",
  minify: true,
  logLevel: "warning",
});
