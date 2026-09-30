import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DiffReviewToolLauncher } from "../core/diff_review/index.js";

export const launchBuiltInDiffTool: DiffReviewToolLauncher = async ({ cwd, env }) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../main.js", import.meta.url)), "diff-tool"],
      { cwd, env, stdio: "ignore", detached: true },
    );

    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.unref();
      resolve();
    });
  });
};
