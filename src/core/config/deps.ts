import { existsSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";

export type ConfigFileSystem = {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  listDir: (path: string) => string[];
  stat: (path: string) => Stats;
};

export type ConfigEnvironment = {
  getEnv: () => NodeJS.ProcessEnv;
  cwd: () => string;
  home: () => string;
};

export type ConfigDeps = {
  fs: ConfigFileSystem;
  env: ConfigEnvironment;
};

export function createDefaultConfigDeps(): ConfigDeps {
  return {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => process.env,
      cwd: () => process.cwd(),
      home: () => homedir(),
    },
  };
}
