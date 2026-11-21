import type { ApiKeysConfig } from "../config/schema.js";
import { ToolCliError } from "./errors.js";
import { runOpenRouterCommand } from "./openrouter.js";
import { printPdfUnpackHelp, runPdfUnpackCommand } from "./pdf_unpack.js";

export type RunToolCommandOptions = {
  config: ApiKeysConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

export function printToolHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau tool <command>",
      "  tau tool <command> --help",
      "",
      "commands:",
      "  pdf-unpack       extract markdown and page image patches from a PDF.",
      "  openrouter       typed decisions and standalone multimodal chat.",
      "",
      "examples:",
      "  tau tool pdf-unpack ./docs/spec.pdf",
      "",
      "documentation: https://github.com/markusylisiurunen/tau/blob/main/docs/tools.md",
    ].join("\n"),
  );
}

export async function runToolCommand(
  argv: string[],
  options: RunToolCommandOptions,
): Promise<void> {
  const [subcommand, ...subcommandArgs] = argv;

  if (!subcommand) {
    throw new ToolCliError("missing tool subcommand", { helpPrinter: printToolHelp });
  }

  if (subcommand === "--help" || subcommand === "-h") {
    printToolHelp();
    return;
  }

  if (subcommand === "pdf-unpack") {
    await runPdfUnpackCommand(subcommandArgs, options);
    return;
  }

  if (subcommand === "openrouter") {
    try {
      await runOpenRouterCommand(subcommandArgs, options);
    } catch (error) {
      if (error instanceof ToolCliError) throw error;
      throw new ToolCliError(
        `${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  if (subcommand.startsWith("-")) {
    throw new ToolCliError(`unknown option: ${subcommand}`, { helpPrinter: printToolHelp });
  }

  throw new ToolCliError(`unknown tool subcommand '${subcommand}'`, {
    helpPrinter: printToolHelp,
  });
}

export { printPdfUnpackHelp, ToolCliError };
