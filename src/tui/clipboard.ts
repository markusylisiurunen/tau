import { spawn } from "node:child_process";

export async function copyTextToClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
    child.on("error", reject);
    child.stderr?.on("data", (d) => reject(new Error(String(d))));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin?.end(text);
  });
}
