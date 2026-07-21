import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export type TelegramProjectPreferenceStore = {
  initialize(): Promise<void>;
  get(ownerId: string): string | undefined;
  set(ownerId: string, projectId: string): Promise<void>;
};

const telegramProjectPreferencesSchema = z
  .object({
    version: z.literal(1),
    preferences: z.record(z.string().min(1), z.string().min(1)),
  })
  .strip();

export function resolveTelegramProjectPreferencesPath(workspaceRoot: string): string {
  return `${resolve(workspaceRoot)}-project-preferences.json`;
}

class FileTelegramProjectPreferenceStore implements TelegramProjectPreferenceStore {
  private readonly path: string;
  private readonly preferences = new Map<string, string>();
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
    return this.preferences.get(ownerId);
  }

  async set(ownerId: string, projectId: string): Promise<void> {
    await this.initialize();
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const previousProjectId = this.preferences.get(ownerId);
        this.preferences.set(ownerId, projectId);
        try {
          await this.writeState();
        } catch (error) {
          if (previousProjectId === undefined) {
            this.preferences.delete(ownerId);
          } else {
            this.preferences.set(ownerId, previousProjectId);
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
        `invalid telegram project preferences: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = telegramProjectPreferencesSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(`invalid telegram project preferences: ${parsed.error.message}`);
    }

    for (const [ownerId, projectId] of Object.entries(parsed.data.preferences)) {
      this.preferences.set(ownerId, projectId);
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    const state: z.infer<typeof telegramProjectPreferencesSchema> = {
      version: 1,
      preferences: Object.fromEntries(this.preferences),
    };
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

export function createTelegramProjectPreferenceStore(path: string): TelegramProjectPreferenceStore {
  return new FileTelegramProjectPreferenceStore(path);
}
