import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageLogEntry = {
  timestamp: number;
  sessionId: string;
  personaId?: string;
  provider: string;
  model: string;
  api: string;
  reasoningEffort: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: {
    total: number;
  };
  agent:
    | { type: "main" }
    | { type: "subagent"; name: string }
    | { type: "review" }
    | { type: "ephemeral" };
};

export function formatUsageDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getUsageLogDir(homeDir?: string): string {
  const home = homeDir ?? homedir();
  return join(home, ".config", "tau", "logs");
}

export function getUsageLogPath(date: Date, homeDir?: string): string {
  const dir = getUsageLogDir(homeDir);
  const key = formatUsageDateKey(date);
  return join(dir, `usage-${key}.jsonl`);
}

export function appendUsageLogEntry(entry: UsageLogEntry, homeDir?: string): void {
  try {
    const logDir = getUsageLogDir(homeDir);
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = getUsageLogPath(new Date(entry.timestamp), homeDir);
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // ignore logging errors
  }
}

export function getUsageTotals(usage?: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): UsageLogEntry["usage"] {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  const total = usage?.totalTokens ?? input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

export function getUsageCostTotal(usage?: { cost?: { total?: number } }): number {
  return usage?.cost?.total ?? 0;
}
