import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AuthStorageData } from "./types.js";

const invalidAuthStorageFormatReason =
  'auth.json format has changed. please run "tau auth login codex" to re-authenticate.';

const nonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0);
const finiteNumberSchema = z.number().finite();

const authStorageDataSchema = z
  .object({
    providers: z.record(
      z.string().refine((value) => value.trim().length > 0),
      z
        .object({
          accounts: z.array(
            z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("oauth"),
                  accountId: nonEmptyStringSchema,
                  providerAccountId: nonEmptyStringSchema.optional(),
                  access: nonEmptyStringSchema,
                  refresh: nonEmptyStringSchema,
                  expires: finiteNumberSchema,
                  enterpriseUrl: nonEmptyStringSchema.optional(),
                  projectId: nonEmptyStringSchema.optional(),
                  usage: z
                    .object({
                      windows: z.array(
                        z
                          .object({
                            name: nonEmptyStringSchema,
                            usedPercent: finiteNumberSchema,
                            resetAt: finiteNumberSchema,
                            windowSeconds: finiteNumberSchema,
                          })
                          .passthrough(),
                      ),
                    })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
              z
                .object({
                  type: z.literal("api_key"),
                  accountId: nonEmptyStringSchema,
                  key: nonEmptyStringSchema,
                })
                .passthrough(),
            ]),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class AuthStorage {
  private data: AuthStorageData = { providers: {} };
  private invalidReason: string | undefined;

  constructor(private readonly authPath: string) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.authPath)) {
      this.data = { providers: {} };
      this.invalidReason = undefined;
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf-8")) as unknown;
      const validated = validateAuthStorageData(parsed);
      this.data = validated.data;
      this.invalidReason = validated.invalidReason;
    } catch (error) {
      this.data = { providers: {} };
      this.invalidReason = `failed to parse auth.json: ${(error as Error)?.message ?? String(error)}`;
    }
  }

  private save(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tmpPath = `${this.authPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, this.authPath);
    chmodSync(this.authPath, 0o600);
  }

  getData(): AuthStorageData {
    return this.data;
  }

  setData(data: AuthStorageData): void {
    this.data = data;
    this.invalidReason = undefined;
    this.save();
  }

  update(mutator: (data: AuthStorageData) => void): void {
    mutator(this.data);
    this.invalidReason = undefined;
    this.save();
  }

  getInvalidReason(): string | undefined {
    return this.invalidReason;
  }
}

function validateAuthStorageData(value: unknown): {
  data: AuthStorageData;
  invalidReason?: string;
} {
  const parsed = authStorageDataSchema.safeParse(value);
  if (!parsed.success) {
    return invalidAuthStorage();
  }

  return {
    data: parsed.data,
  };
}

function invalidAuthStorage(): { data: AuthStorageData; invalidReason: string } {
  return { data: { providers: {} }, invalidReason: invalidAuthStorageFormatReason };
}
