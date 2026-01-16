import { homedir } from "node:os";
import { join } from "node:path";

export function getAuthPath(homeDir?: string): string {
  const home = homeDir ?? homedir();
  return join(home, ".config", "tau", "auth.json");
}
