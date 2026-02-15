import type { AsyncSessionManager, AsyncSessionRecord } from "./session_manager.js";

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const DEFAULT_RUN_HISTORY_LIMIT = 200;

type ParsedCronField = {
  values: Set<number>;
  isWildcard: boolean;
};

export type ParsedCronSchedule = {
  expression: string;
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
};

export type AsyncCronJobConfig = {
  projectId: string;
  schedule: string;
  prompt: string;
};

export type AsyncCronJobRecord = {
  id: string;
  projectId: string;
  schedule: string;
  prompt: string;
};

export type AsyncCronRunTrigger = "scheduled" | "manual";

export type AsyncCronRunStatus = "session-created" | "failed";

export type AsyncCronRunRecord = {
  id: string;
  jobId: string;
  projectId: string;
  schedule: string;
  trigger: AsyncCronRunTrigger;
  triggeredAt: string;
  scheduledFor?: string;
  status: AsyncCronRunStatus;
  sessionId?: string;
  sessionState?: AsyncSessionRecord["state"];
  error?: string;
  errorCode?: string;
};

export type AsyncCronLogLevel = "info" | "warn" | "error";

export type AsyncCronLogEntry = {
  timestamp: string;
  level: AsyncCronLogLevel;
  message: string;
  data?: unknown;
};

export type AsyncCronSchedulerOptions = {
  jobs: Record<string, AsyncCronJobConfig>;
  sessionManager: Pick<AsyncSessionManager, "createSession">;
  additionalSystemMessage?: string;
  pollIntervalMs?: number;
  maxRunHistory?: number;
  now?: () => Date;
  onLog?: (entry: AsyncCronLogEntry) => void;
};

export type AsyncCronListRunsOptions = {
  jobId?: string;
  limit?: number;
};

export type AsyncCronScheduler = {
  close(): Promise<void>;
  listJobs(): AsyncCronJobRecord[];
  listRuns(options?: AsyncCronListRunsOptions): AsyncCronRunRecord[];
  triggerJobNow(jobId: string): Promise<AsyncCronRunRecord>;
};

export type AsyncCronSchedulerHandle = AsyncCronScheduler;

export class AsyncCronSchedulerError extends Error {
  code: "not_found";

  constructor(code: "not_found", message: string) {
    super(message);
    this.name = "AsyncCronSchedulerError";
    this.code = code;
  }
}

type CompiledCronJob = {
  id: string;
  config: AsyncCronJobConfig;
  schedule: ParsedCronSchedule;
};

function parsePositiveInteger(value: string, fieldName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid ${fieldName}: expected a positive integer, got '${value}'`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${fieldName}: expected a positive integer, got '${value}'`);
  }

  return parsed;
}

function parseInteger(value: string, fieldName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid ${fieldName}: expected an integer, got '${value}'`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${fieldName}: expected an integer, got '${value}'`);
  }

  return parsed;
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function validateBounds(value: number, min: number, max: number, fieldName: string): number {
  if (value < min || value > max) {
    throw new Error(`invalid ${fieldName}: value '${value}' is out of range (${min}-${max})`);
  }

  return value;
}

function parseCronField(
  rawField: string,
  options: { fieldName: string; min: number; max: number; normalize?: (value: number) => number },
): ParsedCronField {
  const field = rawField.trim();
  if (!field) {
    throw new Error(`invalid ${options.fieldName}: field cannot be empty`);
  }

  const values = new Set<number>();
  const segments = field.split(",");

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) {
      throw new Error(`invalid ${options.fieldName}: empty list segment`);
    }

    const slashParts = segment.split("/");
    if (slashParts.length > 2) {
      throw new Error(`invalid ${options.fieldName}: too many '/' in '${segment}'`);
    }

    const base = slashParts[0] ?? "";
    const step =
      slashParts.length === 2
        ? parsePositiveInteger(
            slashParts[1] ?? "",
            `${options.fieldName} step in segment '${segment}'`,
          )
        : 1;

    let start: number;
    let end: number;

    if (base === "*") {
      start = options.min;
      end = options.max;
    } else if (base.includes("-")) {
      const rangeParts = base.split("-");
      if (rangeParts.length !== 2) {
        throw new Error(`invalid ${options.fieldName}: invalid range '${base}'`);
      }

      const parsedStart = validateBounds(
        parseInteger(rangeParts[0] ?? "", `${options.fieldName} range start`),
        options.min,
        options.max,
        options.fieldName,
      );
      const parsedEnd = validateBounds(
        parseInteger(rangeParts[1] ?? "", `${options.fieldName} range end`),
        options.min,
        options.max,
        options.fieldName,
      );

      if (parsedStart > parsedEnd) {
        throw new Error(
          `invalid ${options.fieldName}: range start must be <= range end in '${base}'`,
        );
      }

      start = parsedStart;
      end = parsedEnd;
    } else {
      const parsedValue = validateBounds(
        parseInteger(base, options.fieldName),
        options.min,
        options.max,
        options.fieldName,
      );
      start = parsedValue;
      end = parsedValue;
    }

    for (let value = start; value <= end; value += step) {
      const normalized = options.normalize ? options.normalize(value) : value;
      values.add(normalized);
    }
  }

  if (values.size === 0) {
    throw new Error(`invalid ${options.fieldName}: no values were selected`);
  }

  return {
    values,
    isWildcard: field.startsWith("*"),
  };
}

export function parseCronSchedule(expression: string): ParsedCronSchedule {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("cron expression cannot be empty");
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "cron expression must have five fields: minute hour day-of-month month day-of-week",
    );
  }

  return {
    expression: trimmed,
    minute: parseCronField(parts[0] ?? "", {
      fieldName: "minute",
      min: 0,
      max: 59,
    }),
    hour: parseCronField(parts[1] ?? "", {
      fieldName: "hour",
      min: 0,
      max: 23,
    }),
    dayOfMonth: parseCronField(parts[2] ?? "", {
      fieldName: "day-of-month",
      min: 1,
      max: 31,
    }),
    month: parseCronField(parts[3] ?? "", {
      fieldName: "month",
      min: 1,
      max: 12,
    }),
    dayOfWeek: parseCronField(parts[4] ?? "", {
      fieldName: "day-of-week",
      min: 0,
      max: 7,
      normalize: normalizeDayOfWeek,
    }),
  };
}

function resolveDayMatch(schedule: ParsedCronSchedule, date: Date): boolean {
  const domMatches = schedule.dayOfMonth.values.has(date.getDate());
  const dowMatches = schedule.dayOfWeek.values.has(date.getDay());

  if (schedule.dayOfMonth.isWildcard || schedule.dayOfWeek.isWildcard) {
    return domMatches && dowMatches;
  }

  return domMatches || dowMatches;
}

export function matchesCronSchedule(schedule: ParsedCronSchedule, date: Date): boolean {
  if (!schedule.minute.values.has(date.getMinutes())) {
    return false;
  }

  if (!schedule.hour.values.has(date.getHours())) {
    return false;
  }

  if (!schedule.month.values.has(date.getMonth() + 1)) {
    return false;
  }

  return resolveDayMatch(schedule, date);
}

function minuteBucket(now: Date): number {
  return Math.floor(now.getTime() / MILLISECONDS_PER_MINUTE);
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const record = error as { code?: unknown };
  return typeof record.code === "string" ? record.code : undefined;
}

type RunJobTriggerContext =
  | {
      trigger: "manual";
    }
  | {
      trigger: "scheduled";
      scheduledFor: string;
    };

class AsyncCronSchedulerImpl implements AsyncCronScheduler {
  private readonly jobs: CompiledCronJob[];
  private readonly jobsById: Map<string, CompiledCronJob>;
  private readonly sessionManager: Pick<AsyncSessionManager, "createSession">;
  private readonly additionalSystemMessage?: string;
  private readonly pollIntervalMs: number;
  private readonly maxRunHistory: number;
  private readonly now: () => Date;
  private readonly onLog?: (entry: AsyncCronLogEntry) => void;
  private readonly runHistory: AsyncCronRunRecord[] = [];
  private timer?: NodeJS.Timeout;
  private lastCheckedMinute?: number;
  private runSequence = 0;
  private closed = false;

  constructor(options: AsyncCronSchedulerOptions) {
    this.jobs = Object.entries(options.jobs).map(([id, config]) => ({
      id,
      config,
      schedule: parseCronSchedule(config.schedule),
    }));

    this.jobsById = new Map(this.jobs.map((job) => [job.id, job]));
    this.sessionManager = options.sessionManager;
    this.additionalSystemMessage = options.additionalSystemMessage?.trim() || undefined;
    this.pollIntervalMs = options.pollIntervalMs ?? MILLISECONDS_PER_SECOND;
    this.maxRunHistory = options.maxRunHistory ?? DEFAULT_RUN_HISTORY_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.onLog = options.onLog;

    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("cron scheduler pollIntervalMs must be a positive integer");
    }

    if (!Number.isInteger(this.maxRunHistory) || this.maxRunHistory <= 0) {
      throw new Error("cron scheduler maxRunHistory must be a positive integer");
    }

    this.tick();

    this.timer = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);

    this.timer.unref?.();

    this.log("info", "cron scheduler started", { jobCount: this.jobs.length });
  }

  listJobs(): AsyncCronJobRecord[] {
    return this.jobs.map((job) => ({
      id: job.id,
      projectId: job.config.projectId,
      schedule: job.config.schedule,
      prompt: job.config.prompt,
    }));
  }

  listRuns(options?: AsyncCronListRunsOptions): AsyncCronRunRecord[] {
    const jobId = options?.jobId?.trim();
    const limit = options?.limit;
    const filtered = [...this.runHistory]
      .reverse()
      .filter((run) => (jobId ? run.jobId === jobId : true));

    if (limit === undefined) {
      return filtered.map((run) => ({ ...run }));
    }

    if (!Number.isInteger(limit) || limit <= 0) {
      return [];
    }

    return filtered.slice(0, limit).map((run) => ({ ...run }));
  }

  async triggerJobNow(jobId: string): Promise<AsyncCronRunRecord> {
    const normalizedJobId = jobId.trim();
    const job = this.jobsById.get(normalizedJobId);

    if (!job) {
      throw new AsyncCronSchedulerError("not_found", `cron job '${normalizedJobId}' not found`);
    }

    this.log("info", "cron job triggered", {
      jobId: job.id,
      projectId: job.config.projectId,
      schedule: job.config.schedule,
      trigger: "manual",
    });

    return await this.runJob(job, { trigger: "manual" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.log("info", "cron scheduler stopped");
  }

  private tick(): void {
    if (this.closed || this.jobs.length === 0) {
      return;
    }

    const currentMinute = minuteBucket(this.now());

    if (this.lastCheckedMinute === undefined) {
      this.lastCheckedMinute = currentMinute - 1;
    }

    if (currentMinute < this.lastCheckedMinute) {
      this.log("warn", "system clock moved backwards, resetting cron cursor", {
        currentMinute,
        previousMinute: this.lastCheckedMinute,
      });
      this.lastCheckedMinute = currentMinute - 1;
    }

    for (
      let minute = (this.lastCheckedMinute ?? currentMinute) + 1;
      minute <= currentMinute;
      minute += 1
    ) {
      const slotDate = new Date(minute * MILLISECONDS_PER_MINUTE);

      for (const job of this.jobs) {
        if (!matchesCronSchedule(job.schedule, slotDate)) {
          continue;
        }

        this.log("info", "cron job triggered", {
          jobId: job.id,
          projectId: job.config.projectId,
          schedule: job.config.schedule,
          trigger: "scheduled",
          scheduledFor: slotDate.toISOString(),
        });

        void this.runJob(job, {
          trigger: "scheduled",
          scheduledFor: slotDate.toISOString(),
        });
      }
    }

    this.lastCheckedMinute = currentMinute;
  }

  private async runJob(
    job: CompiledCronJob,
    trigger: RunJobTriggerContext,
  ): Promise<AsyncCronRunRecord> {
    const triggeredAt = this.now().toISOString();
    const runId = `${triggeredAt}:${this.runSequence}`;
    this.runSequence += 1;

    try {
      const session = await this.sessionManager.createSession({
        projectId: job.config.projectId,
        prompt: job.config.prompt,
        ...(this.additionalSystemMessage
          ? { additionalSystemMessage: this.additionalSystemMessage }
          : {}),
      });

      const run: AsyncCronRunRecord = {
        id: runId,
        jobId: job.id,
        projectId: job.config.projectId,
        schedule: job.config.schedule,
        trigger: trigger.trigger,
        triggeredAt,
        ...(trigger.trigger === "scheduled" ? { scheduledFor: trigger.scheduledFor } : {}),
        status: "session-created",
        sessionId: session.id,
        sessionState: session.state,
      };

      this.pushRun(run);
      this.log("info", "cron job session created", {
        jobId: job.id,
        sessionId: session.id,
        projectId: job.config.projectId,
        state: session.state,
        trigger: trigger.trigger,
      });

      return { ...run };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const code = readErrorCode(error);

      const run: AsyncCronRunRecord = {
        id: runId,
        jobId: job.id,
        projectId: job.config.projectId,
        schedule: job.config.schedule,
        trigger: trigger.trigger,
        triggeredAt,
        ...(trigger.trigger === "scheduled" ? { scheduledFor: trigger.scheduledFor } : {}),
        status: "failed",
        error: cause,
        ...(code ? { errorCode: code } : {}),
      };

      this.pushRun(run);
      this.log("error", "cron job failed to create session", {
        jobId: job.id,
        projectId: job.config.projectId,
        trigger: trigger.trigger,
        ...(code ? { code } : {}),
        cause,
      });

      return { ...run };
    }
  }

  private pushRun(run: AsyncCronRunRecord): void {
    this.runHistory.push(run);

    if (this.runHistory.length <= this.maxRunHistory) {
      return;
    }

    this.runHistory.splice(0, this.runHistory.length - this.maxRunHistory);
  }

  private log(level: AsyncCronLogLevel, message: string, data?: unknown): void {
    this.onLog?.({
      timestamp: this.now().toISOString(),
      level,
      message,
      ...(data === undefined ? {} : { data }),
    });
  }
}

export function startAsyncCronScheduler(options: AsyncCronSchedulerOptions): AsyncCronScheduler {
  return new AsyncCronSchedulerImpl(options);
}
