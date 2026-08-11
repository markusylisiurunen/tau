import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export type TelegramProjectPreferenceStore = {
  initialize(): Promise<void>;
  get(ownerId: string): string | undefined;
  set(ownerId: string, projectId: string): Promise<void>;
  isTtsEnabled(ownerId: string): boolean;
  setTtsEnabled(ownerId: string, enabled: boolean): Promise<void>;
};

type TelegramPreferences = {
  projectId?: string;
  ttsEnabled: boolean;
};

const telegramProjectPreferencesV1Schema = z
  .object({
    version: z.literal(1),
    preferences: z.record(z.string().min(1), z.string().min(1)),
  })
  .strip();

const telegramPreferencesV2Schema = z
  .object({
    version: z.literal(2),
    preferences: z.record(
      z.string().min(1),
      z
        .object({
          projectId: z.string().min(1).optional(),
          ttsEnabled: z.boolean(),
        })
        .strip(),
    ),
  })
  .strip();

const telegramPreferencesSchema = z.discriminatedUnion("version", [
  telegramProjectPreferencesV1Schema,
  telegramPreferencesV2Schema,
]);

export function resolveTelegramProjectPreferencesPath(workspaceRoot: string): string {
  return `${resolve(workspaceRoot)}-project-preferences.json`;
}

class FileTelegramProjectPreferenceStore implements TelegramProjectPreferenceStore {
  private readonly path: string;
  private readonly preferences = new Map<string, TelegramPreferences>();
  private initializePromise?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.load();
    }
    await this.initializePromise;
  }

  get(ownerId: string): string | undefined {
    return this.preferences.get(ownerId)?.projectId;
  }

  async set(ownerId: string, projectId: string): Promise<void> {
    await this.update(ownerId, (preferences) => ({ ...preferences, projectId }));
  }

  isTtsEnabled(ownerId: string): boolean {
    return this.preferences.get(ownerId)?.ttsEnabled ?? false;
  }

  async setTtsEnabled(ownerId: string, enabled: boolean): Promise<void> {
    await this.update(ownerId, (preferences) => ({ ...preferences, ttsEnabled: enabled }));
  }

  private async update(
    ownerId: string,
    updatePreferences: (preferences: TelegramPreferences) => TelegramPreferences,
  ): Promise<void> {
    await this.initialize();
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const previousPreferences = this.preferences.get(ownerId);
        this.preferences.set(
          ownerId,
          updatePreferences(previousPreferences ?? { ttsEnabled: false }),
        );
        try {
          await this.writeState();
        } catch (error) {
          if (previousPreferences === undefined) {
            this.preferences.delete(ownerId);
          } else {
            this.preferences.set(ownerId, previousPreferences);
          }
          throw error;
        }
      });
    this.writeQueue = write;
    await write;
  }

  private async load(): Promise<void> {
    const raw = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (raw === undefined) {
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `invalid telegram preferences: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = telegramPreferencesSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(`invalid telegram preferences: ${parsed.error.message}`);
    }

    if (parsed.data.version === 1) {
      for (const [ownerId, projectId] of Object.entries(parsed.data.preferences)) {
        this.preferences.set(ownerId, { projectId, ttsEnabled: false });
      }
      return;
    }

    for (const [ownerId, preferences] of Object.entries(parsed.data.preferences)) {
      this.preferences.set(ownerId, preferences);
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    const state: z.infer<typeof telegramPreferencesV2Schema> = {
      version: 2,
      preferences: Object.fromEntries(this.preferences),
    };
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

export function createTelegramProjectPreferenceStore(path: string): TelegramProjectPreferenceStore {
  return new FileTelegramProjectPreferenceStore(path);
}
