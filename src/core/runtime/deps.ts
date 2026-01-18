import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnWithCapture } from "../utils/spawn_capture.js";

export type CoreClock = {
  now: () => number;
};

export type CoreFileSystem = {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  listDir: (path: string) => string[];
};

export type CoreEnvironment = {
  cwd: () => string;
  home: () => string;
  platform: () => NodeJS.Platform;
  nodeVersion: () => string;
  env: () => NodeJS.ProcessEnv;
};

export type CoreDeps = {
  clock: CoreClock;
  fs: CoreFileSystem;
  spawn: typeof spawnWithCapture;
  env: CoreEnvironment;
};

export function createDefaultCoreDeps(): CoreDeps {
  return {
    clock: {
      now: () => Date.now(),
    },
    fs: {
      readFile: (path: string) => readFileSync(path, "utf-8"),
      writeFile: (path: string, content: string) => {
        writeFileSync(path, content, "utf-8");
      },
      listDir: (path: string) => readdirSync(path),
    },
    spawn: spawnWithCapture,
    env: {
      cwd: () => process.cwd(),
      home: () => homedir(),
      platform: () => process.platform,
      nodeVersion: () => process.version,
      env: () => process.env,
    },
  };
}
