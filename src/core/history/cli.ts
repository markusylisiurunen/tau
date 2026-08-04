import { destroyHistoryService, setupHistoryService } from "./setup.js";

export class HistoryCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryCliError";
  }
}

export function printHistoryHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau history setup --domain <domain> --zone-name <zone> [--api-key <key>]  # Workers Paid",
      "  tau history destroy --yes",
    ].join("\n"),
  );
}

export async function runHistoryCommand(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdout?: (line: string) => void } = {},
): Promise<void> {
  const stdout = options.stdout ?? console.log;
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHistoryHelp(stdout);
    return;
  }

  try {
    if (subcommand === "setup") {
      let domain = options.env?.TAU_HISTORY_DOMAIN;
      let zoneName = options.env?.TAU_HISTORY_ZONE_NAME;
      let apiKey: string | undefined;
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--domain" || argument.startsWith("--domain=")) {
          const parsed = parseValue(argument, args, index);
          domain = parsed.value;
          index = parsed.nextIndex;
        } else if (argument === "--zone-name" || argument.startsWith("--zone-name=")) {
          const parsed = parseValue(argument, args, index);
          zoneName = parsed.value;
          index = parsed.nextIndex;
        } else if (argument === "--api-key" || argument.startsWith("--api-key=")) {
          const parsed = parseValue(argument, args, index);
          apiKey = parsed.value;
          index = parsed.nextIndex;
        } else {
          throw new Error(`unknown option: ${argument}`);
        }
      }
      if (!domain || !zoneName) {
        throw new Error("tau history setup requires --domain and --zone-name");
      }
      await setupHistoryService({
        domain,
        zoneName,
        ...(apiKey ? { apiKey } : {}),
        env: options.env,
        stdout,
      });
      return;
    }

    if (subcommand === "destroy") {
      if (args.some((argument) => argument !== "--yes")) {
        throw new Error(`unknown option: ${args.find((argument) => argument !== "--yes")}`);
      }
      await destroyHistoryService({
        yes: args.includes("--yes"),
        env: options.env,
        stdout,
      });
      return;
    }

    throw new Error(`unknown history subcommand '${subcommand}'`);
  } catch (error) {
    throw new HistoryCliError(error instanceof Error ? error.message : String(error));
  }
}

function parseValue(
  argument: string,
  argv: string[],
  index: number,
): { value: string; nextIndex: number } {
  const equals = argument.indexOf("=");
  if (equals >= 0) {
    const value = argument.slice(equals + 1);
    if (!value) throw new Error(`missing value for ${argument.slice(0, equals)}`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`missing value for ${argument}`);
  return { value, nextIndex: index + 1 };
}
