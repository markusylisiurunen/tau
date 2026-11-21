import type { ApiKeysConfig } from "../config/schema.js";
import { getMistralApiKey } from "../config/schema.js";
import { describeMediaError } from "../media/media.js";
import { unpackPdf } from "../media/pdf.js";
import {
  createLocalToolExecutionBackend,
  scopeToolExecutionBackend,
} from "../tools/execution_backend.js";
import { ToolCliError } from "./errors.js";
export type RunPdfUnpackCommandOptions = {
  config: ApiKeysConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  fetchImpl?: typeof fetch;
};
type ParsedPdfUnpackArgs = {
  help: boolean;
  inputPath?: string;
};

function parsePdfUnpackArgs(argv: string[]): ParsedPdfUnpackArgs {
  let help = false;
  let inputPath: string | undefined;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new ToolCliError(`unknown option: ${arg}`, { helpPrinter: printPdfUnpackHelp });
    }

    if (inputPath !== undefined) {
      throw new ToolCliError(`unexpected argument: ${arg}`, { helpPrinter: printPdfUnpackHelp });
    }

    inputPath = arg;
  }

  return {
    help,
    inputPath,
  };
}

export function printPdfUnpackHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau tool pdf-unpack <file.pdf>",
      "",
      "options:",
      "  --help  show this help and exit.",
      "",
      "artifacts:",
      "  writes a persistent temp directory containing document.md, pages/, and images/.",
      "",
      "notes:",
      "  requires pdftoppm from Poppler on PATH.",
      "  requires apiKeys.mistral or MISTRAL_API_KEY for OCR.",
      "  keeps the output directory on disk for follow-up use.",
      "",
      "documentation: https://github.com/markusylisiurunen/tau/blob/main/docs/pdf-unpacking.md",
    ].join("\n"),
  );
}

export async function runPdfUnpackCommand(argv: string[], options: RunPdfUnpackCommandOptions) {
  const parsed = parsePdfUnpackArgs(argv);
  if (parsed.help) return printPdfUnpackHelp(options.stdout);
  if (!parsed.inputPath)
    throw new ToolCliError("missing PDF path", { helpPrinter: printPdfUnpackHelp });
  const backend = scopeToolExecutionBackend(
    createLocalToolExecutionBackend(),
    options.cwd ?? process.cwd(),
  );
  try {
    const result = await unpackPdf(
      parsed.inputPath,
      undefined,
      { ...options, backend, signal: new AbortController().signal },
      getMistralApiKey(options.config, options.env),
    );
    (options.stdout ?? console.log)(JSON.stringify(result, null, 2));
  } catch (error) {
    throw new ToolCliError(describeMediaError(error));
  } finally {
    await backend.dispose();
  }
}
