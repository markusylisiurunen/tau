import { createCodeTool } from "../../dist/core/tools/code.js";
import { CodeJobRegistry } from "../../dist/core/tools/code_jobs.js";

export function createPackageTool(backend, pkg) {
  return createCodeTool({
    backend,
    cwd: process.cwd(),
    codeJobs: new CodeJobRegistry(),
    summaries: [pkg],
    packagesFor: () => [pkg],
    readFiles: true,
  });
}
