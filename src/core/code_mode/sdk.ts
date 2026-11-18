import { readFileSync } from "node:fs";
import { z } from "zod";
import type { TauCodeModeApi } from "../../code_mode/runtime.js";
import type { CodeModeCapability } from "./capability.js";
import { codeModeError } from "./errors.js";

const root = new URL("../static/code_mode/docs/", import.meta.url);
const pages = new Map(
  ["core", "web", "models", "agents", "history", "mcp", "examples"].map((page) => [
    page === "examples" ? page : `@tau/${page}`,
    readFileSync(new URL(`${page}.md`, root), "utf8"),
  ]),
);

export function bindCodeModeSdk(capabilities: CodeModeCapability[], files: TauCodeModeApi = {}) {
  const packages: Record<string, TauCodeModeApi> = {
    "@tau/core": {
      ...(Object.keys(files).length ? { files } : {}),
      docs: (args) => {
        const [page = "@tau/core"] = z.tuple([z.string().optional()]).parse(args);
        if (page !== "examples" && !Object.hasOwn(packages, page)) {
          throw codeModeError("UNAVAILABLE_PACKAGE", `Unavailable Code Mode package: ${page}`);
        }
        return pages.get(page)!;
      },
    },
  };
  for (const { name, api } of capabilities) {
    if (name === "bash") packages["@tau/core"]!.bash = api;
    else packages[`@tau/${name}`] = api;
  }
  return { packages, documentation: pages.get("@tau/core")! };
}
