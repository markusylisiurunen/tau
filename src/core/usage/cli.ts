import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { formatAdaptiveNumber, formatTokenWindow } from "../utils/format.js";
import { formatUsageDateKey, getUsageLogDir } from "./logs.js";

export class UsageCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageCliError";
  }
}

const UsageGroupBySchema = z.enum(["day", "model"]);
type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

type UsageCliOptions = {
  help: boolean;
  sinceKey?: string;
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

const usageNumberSchema = z.coerce.number().finite();

const usageLogEntrySchema = z
  .object({
    timestamp: usageNumberSchema,
    personaId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: z
      .object({
        input: usageNumberSchema.optional(),
        output: usageNumberSchema.optional(),
        cacheRead: usageNumberSchema.optional(),
        cacheWrite: usageNumberSchema.optional(),
        total: usageNumberSchema.optional(),
      })
      .passthrough()
      .optional(),
    cost: z
      .object({
        total: usageNumberSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

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

function parseGroupBy(value: string): UsageGroupBy {
  const parsed = UsageGroupBySchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageCliError(`invalid group-by '${value}'. expected day or model.`);
  }

  return parsed.data;
}

function parseSince(raw: string): string {
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

function parseUsageArgs(argv: string[]): UsageCliOptions {
  let help = false;
  let sinceRaw: string | undefined;
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

    const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (option) {
      case "--since": {
        const parsed = parseValue(arg, argv, i);
        sinceRaw = parsed.value;
        i = parsed.next;
        break;
      }
      case "--persona": {
        const parsed = parseValue(arg, argv, i);
        persona = parsed.value;
        i = parsed.next;
        break;
      }
      case "--provider": {
        const parsed = parseValue(arg, argv, i);
        provider = parsed.value;
        i = parsed.next;
        break;
      }
      case "--model": {
        const parsed = parseValue(arg, argv, i);
        model = parsed.value;
        i = parsed.next;
        break;
      }
      case "--group-by": {
        const parsed = parseValue(arg, argv, i);
        groupBy = parseGroupBy(parsed.value);
        i = parsed.next;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new UsageCliError(`unknown option: ${arg}`);
        }
        throw new UsageCliError(`unexpected argument: ${arg}`);
    }
  }

  return {
    help,
    sinceKey: !help && sinceRaw !== undefined ? parseSince(sinceRaw) : undefined,
    persona,
    provider,
    model,
    groupBy,
  };
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
    requests?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    costTotal?: number;
  },
): void {
  target.requests += entry.requests ?? 1;
  target.input += entry.input ?? 0;
  target.output += entry.output ?? 0;
  target.cacheRead += entry.cacheRead ?? 0;
  target.cacheWrite += entry.cacheWrite ?? 0;
  target.total += entry.total ?? 0;
  target.costTotal += entry.costTotal ?? 0;
}

function formatAggregateRow(label: string, aggregate: UsageAggregate): string[] {
  return [
    label,
    `requests: ${aggregate.requests}`,
    `↑${formatTokenWindow(aggregate.input)}`,
    `↓${formatTokenWindow(aggregate.output)}`,
    `r${formatTokenWindow(aggregate.cacheRead)}`,
    `w${formatTokenWindow(aggregate.cacheWrite)}`,
    `total: ${formatTokenWindow(aggregate.total)}`,
    `cost: $${formatAdaptiveNumber(aggregate.costTotal, 2, 5)}`,
  ];
}

type ParsedUsageLogEntry = {
  entryDateKey: string;
  personaId?: string;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costTotal: number;
};

function parseUsageLogLine(line: string): ParsedUsageLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const parsedEntry = usageLogEntrySchema.safeParse(parsed);
  if (!parsedEntry.success) {
    return null;
  }

  const usage = parsedEntry.data.usage;
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;

  return {
    entryDateKey: formatUsageDateKey(new Date(parsedEntry.data.timestamp)),
    personaId: parsedEntry.data.personaId,
    provider: parsedEntry.data.provider,
    model: parsedEntry.data.model,
    input,
    output,
    cacheRead,
    cacheWrite,
    total: usage?.total ?? input + output + cacheRead + cacheWrite,
    costTotal: parsedEntry.data.cost?.total ?? 0,
  };
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

  const sinceKey = options.sinceKey;

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

      const entry = parseUsageLogLine(trimmed);
      if (!entry) {
        continue;
      }

      if (sinceKey && entry.entryDateKey < sinceKey) {
        continue;
      }

      if (!matchesFilter(entry.personaId, options.persona)) {
        continue;
      }
      if (!matchesFilter(entry.provider, options.provider)) {
        continue;
      }
      if (!matchesFilter(entry.model, options.model)) {
        continue;
      }

      const groupKey =
        options.groupBy === "model"
          ? `${entry.provider ?? "unknown"}/${entry.model ?? "unknown"}`
          : entry.entryDateKey;
      const aggregate = aggregates.get(groupKey) ?? toAggregate();
      appendAggregate(aggregate, entry);
      aggregates.set(groupKey, aggregate);
    }
  }

  if (aggregates.size === 0) {
    console.log("no usage entries matched filters.");
    return;
  }

  const rows: string[][] = [];
  const totalAggregate = toAggregate();

  for (const groupKey of [...aggregates.keys()].sort()) {
    const aggregate = aggregates.get(groupKey)!;
    appendAggregate(totalAggregate, aggregate);
    rows.push(formatAggregateRow(groupKey, aggregate));
  }

  const totalRow = formatAggregateRow("total", totalAggregate);
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
