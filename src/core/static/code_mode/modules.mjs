import { Buffer } from "node:buffer";
import { dirname, isAbsolute, resolve } from "node:path";
import { build } from "esbuild";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 64;

// The bundler only reads sources through these hooks. Its output still runs in SES.
export async function compileModules({ code, cwd, entryPath, packages, readSource }) {
  const entry = entryPath ?? "<inline>";
  const wrapper = "<program>";
  let files = 0;
  let bytes = 0;
  let sourceReads = Promise.resolve();
  const loadSource = async (path) => {
    const next = sourceReads.then(() => readSource(path));
    sourceReads = next.then(() => {}, () => {});
    return next;
  };
  const { outputFiles } = await build({
    entryPoints: [wrapper],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    define: { "import.meta": "{}", require: "undefined" },
    logLevel: "silent",
    plugins: [{
      name: "tau-modules",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path, importer, kind, with: attributes }) => {
          if (kind === "entry-point") return { path: wrapper, namespace: "tau-entry" };
          if (kind !== "import-statement" || Object.keys(attributes).length > 0) {
            throw new Error("Code Mode supports static JavaScript imports without attributes");
          }
          if (importer === wrapper) return { path: entry, namespace: "tau-source" };
          if (Object.hasOwn(packages, path)) return { path, namespace: "tau-package" };
          if ((isAbsolute(path) || path.startsWith("./") || path.startsWith("../")) && path.endsWith(".js") && !path.includes("\0")) {
            return { path: resolve(importer === "<inline>" ? cwd : dirname(importer), path), namespace: "tau-source" };
          }
          throw new Error(`Unavailable Code Mode module: ${path}`);
        });
        builder.onLoad({ filter: /.*/, namespace: "tau-entry" }, () => ({
          contents: `import ${JSON.stringify(entry)};`,
        }));
        // Export names may be reserved words such as `delete`, so bind each export to a
        // generated local name. Export names never collide with local bindings.
        builder.onLoad({ filter: /.*/, namespace: "tau-package" }, ({ path }) => {
          const names = Object.keys(packages[path]);
          return {
            contents: `const p = __tauPackages[${JSON.stringify(path)}];\n` +
              names.map((name, index) => `const m${index} = p[${JSON.stringify(name)}];`).join("\n") +
              `\nexport { ${names.map((name, index) => `m${index} as ${name}`).join(", ")} };`,
          };
        });
        builder.onLoad({ filter: /.*/, namespace: "tau-source" }, async ({ path }) => {
          if (++files > MAX_FILES) throw new Error(`Program exceeds ${MAX_FILES} source files`);
          const contents = path === entry ? code : await loadSource(path);
          bytes += Buffer.byteLength(contents);
          if (bytes > MAX_SOURCE_BYTES) throw new Error("Program source exceeds 8 MiB");
          return { contents: `${contents}\nexport {};`, loader: "js" };
        });
      },
    }],
  });
  return outputFiles[0].text;
}
