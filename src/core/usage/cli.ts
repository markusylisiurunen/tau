import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatAdaptiveNumber, formatTokenWindow } from "../utils/format.js";
import { formatUsageDateKey, getUsageLogDir } from "./logs.js";

export class UsageCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageCliError";
  }
}

type UsageGroupBy = "day" | "model";

type UsageCliOptions = {
  help: boolean;
  since?: string;
  persona?: string;
  provider?: string;
  model?: string;
  groupBy: UsageGroupBy;
};

type UsageAggregate = {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costTotal: number;
};

const LOG_FILE_PATTERN = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function parseValue(arg: string, argv: string[], index: number): { value: string; next: number } {
  const eqIndex = arg.indexOf("=");
  if (eqIndex !== -1) {
    const value = arg.slice(eqIndex + 1).trim();
    if (!value) {
      throw new UsageCliError(`missing value for ${arg.slice(0, eqIndex)}`);
    }
    return { value, next: index };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new UsageCliError(`missing value for ${arg}`);
  }

  return { value: next, next: index + 1 };
}

function parseUsageArgs(argv: string[]): UsageCliOptions {
  let help = false;
  let since: string | undefined;
  let persona: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let groupBy: UsageGroupBy = "day";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--since" || arg.startsWith("--since=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.next;
      since = parsed.value;
      continue;
    }

    if (arg === "--persona" || arg.startsWith("--persona=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.next;
      persona = parsed.value;
      continue;
    }

    if (arg === "--provider" || arg.startsWith("--provider=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.next;
      provider = parsed.value;
      continue;
    }

    if (arg === "--model" || arg.startsWith("--model=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.next;
      model = parsed.value;
      continue;
    }

    if (arg === "--group-by" || arg.startsWith("--group-by=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.next;
      if (parsed.value !== "day" && parsed.value !== "model") {
        throw new UsageCliError(`invalid group-by '${parsed.value}'. expected day or model.`);
      }
      groupBy = parsed.value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageCliError(`unknown option: ${arg}`);
    }

    throw new UsageCliError(`unexpected argument: ${arg}`);
  }

  return { help, since, persona, provider, model, groupBy };
}

function parseSinceDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new UsageCliError("missing value for --since");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageCliError(`invalid date '${raw}'. expected YYYY-MM-DD or ISO date.`);
  }

  return formatUsageDateKey(parsed);
}

function toAggregate(): UsageAggregate {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    costTotal: 0,
  };
}

function matchesFilter(value: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!value) return false;
  return value.toLowerCase() === filter.toLowerCase();
}

function appendAggregate(
  target: UsageAggregate,
  entry: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    costTotal?: number;
  },
): void {
  target.requests += 1;
  target.input += entry.input ?? 0;
  target.output += entry.output ?? 0;
  target.cacheRead += entry.cacheRead ?? 0;
  target.cacheWrite += entry.cacheWrite ?? 0;
  target.total += entry.total ?? 0;
  target.costTotal += entry.costTotal ?? 0;
}

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function printUsageHelp(): void {
  console.log(
    [
      "usage:",
      "  tau usage [options]",
      "",
      "options:",
      "  --since <date>      include entries on or after date (YYYY-MM-DD or ISO).",
      "  --persona <id>      filter by persona id.",
      "  --provider <name>   filter by provider.",
      "  --model <id>        filter by model id.",
      "  --group-by <value>  group by day or model (default: day).",
      "  --help              show this help and exit.",
    ].join("\n"),
  );
}

export async function runUsageCommand(argv: string[]): Promise<void> {
  const options = parseUsageArgs(argv);
  if (options.help) {
    printUsageHelp();
    return;
  }

  const sinceKey = options.since ? parseSinceDate(options.since) : undefined;

  const logDir = getUsageLogDir();
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.log("no usage logs found.");
      return;
    }
    throw error;
  }

  const aggregates = new Map<string, UsageAggregate>();
  const logFiles = files
    .map((name) => LOG_FILE_PATTERN.exec(name))
    .filter(Boolean)
    .map((match) => ({ name: match![0], dateKey: match![1]! }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  for (const file of logFiles) {
    if (sinceKey && file.dateKey < sinceKey) {
      continue;
    }

    const fullPath = join(logDir, file.name);
    let content = "";
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const timestamp = Number(parsed?.timestamp ?? NaN);
      if (!Number.isFinite(timestamp)) {
        continue;
      }

      const entryDateKey = formatUsageDateKey(new Date(timestamp));
      if (sinceKey && entryDateKey < sinceKey) {
        continue;
      }

      const personaId = typeof parsed.personaId === "string" ? parsed.personaId : undefined;
      const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
      const model = typeof parsed.model === "string" ? parsed.model : undefined;

      if (!matchesFilter(personaId, options.persona)) {
        continue;
      }
      if (!matchesFilter(provider, options.provider)) {
        continue;
      }
      if (!matchesFilter(model, options.model)) {
        continue;
      }

      const usage =
        parsed.usage && typeof parsed.usage === "object"
          ? (parsed.usage as Record<string, unknown>)
          : {};
      const input = readNumber(usage.input);
      const output = readNumber(usage.output);
      const cacheRead = readNumber(usage.cacheRead);
      const cacheWrite = readNumber(usage.cacheWrite);
      const rawTotal = usage.total;
      const total =
        rawTotal !== undefined ? readNumber(rawTotal) : input + output + cacheRead + cacheWrite;
      const cost = parsed.cost as Record<string, unknown> | undefined;
      const costTotal = readNumber(cost?.total);

      const groupKey =
        options.groupBy === "model"
          ? `${provider ?? "unknown"}/${model ?? "unknown"}`
          : entryDateKey;
      const aggregate = aggregates.get(groupKey) ?? toAggregate();
      appendAggregate(aggregate, { input, output, cacheRead, cacheWrite, total, costTotal });
      aggregates.set(groupKey, aggregate);
    }
  }

  if (aggregates.size === 0) {
    console.log("no usage entries matched filters.");
    return;
  }

  const rows: string[][] = [];
  const totalAggregate = toAggregate();

  for (const dateKey of [...aggregates.keys()].sort()) {
    const aggregate = aggregates.get(dateKey)!;
    totalAggregate.requests += aggregate.requests;
    totalAggregate.input += aggregate.input;
    totalAggregate.output += aggregate.output;
    totalAggregate.cacheRead += aggregate.cacheRead;
    totalAggregate.cacheWrite += aggregate.cacheWrite;
    totalAggregate.total += aggregate.total;
    totalAggregate.costTotal += aggregate.costTotal;

    const input = `↑${formatTokenWindow(aggregate.input)}`;
    const output = `↓${formatTokenWindow(aggregate.output)}`;
    const cacheRead = `r${formatTokenWindow(aggregate.cacheRead)}`;
    const cacheWrite = `w${formatTokenWindow(aggregate.cacheWrite)}`;
    const total = formatTokenWindow(aggregate.total);
    const cost = `$${formatAdaptiveNumber(aggregate.costTotal, 2, 5)}`;

    rows.push([
      dateKey,
      `requests: ${aggregate.requests}`,
      input,
      output,
      cacheRead,
      cacheWrite,
      `total: ${total}`,
      `cost: ${cost}`,
    ]);
  }

  const totalInput = `↑${formatTokenWindow(totalAggregate.input)}`;
  const totalOutput = `↓${formatTokenWindow(totalAggregate.output)}`;
  const totalCacheRead = `r${formatTokenWindow(totalAggregate.cacheRead)}`;
  const totalCacheWrite = `w${formatTokenWindow(totalAggregate.cacheWrite)}`;
  const totalTokens = formatTokenWindow(totalAggregate.total);
  const totalCost = `$${formatAdaptiveNumber(totalAggregate.costTotal, 2, 5)}`;
  const totalRow = [
    "total",
    `requests: ${totalAggregate.requests}`,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    `total: ${totalTokens}`,
    `cost: ${totalCost}`,
  ];
  const allRows = [...rows, totalRow];
  const columnWidths = allRows.reduce((widths, row) => {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
    return widths;
  }, [] as number[]);
  const formatRow = (row: string[]): string =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(columnWidths[index]!)))
      .join("  ");

  for (const row of rows) {
    console.log(formatRow(row));
  }

  console.log("");
  console.log(formatRow(totalRow));
}
