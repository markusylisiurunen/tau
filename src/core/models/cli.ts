import { homedir } from "node:os";
import { getDefaultModelCatalogStorePath, RemoteModelCatalog } from "./remote_catalog.js";

export class ModelsCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsCliError";
  }
}

export function printModelsHelp(): void {
  console.log(
    [
      "usage:",
      "  tau models refresh",
      "  tau models --help",
      "",
      "subcommands:",
      "  refresh  force a best-effort refresh of every remote model catalog.",
    ].join("\n"),
  );
}

export async function runModelsCommand(
  args: string[],
  options: {
    home?: string;
    catalog?: RemoteModelCatalog;
  } = {},
): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printModelsHelp();
    return;
  }
  if (args[0] !== "refresh" || args.length !== 1) {
    throw new ModelsCliError(`unknown models command '${args.join(" ")}'`);
  }

  const home = options.home ?? homedir();
  const catalog =
    options.catalog ?? new RemoteModelCatalog({ path: getDefaultModelCatalogStorePath(home) });
  const result = await catalog.refresh({ force: true });
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const [provider, providerResult] of result.providers) {
    if (providerResult.status === "updated") updated += 1;
    else if (providerResult.status === "failed") {
      failed += 1;
      failures.push(`${provider}: ${providerResult.error.message}`);
    } else unchanged += 1;
  }

  console.log(
    `model catalogs refreshed: ${updated} updated, ${unchanged} unchanged, ${failed} failed`,
  );
  if (failures.length > 0) {
    throw new ModelsCliError(
      `failed providers:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
}
