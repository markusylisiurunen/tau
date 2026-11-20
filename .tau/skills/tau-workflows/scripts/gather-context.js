// Gather the conversations behind a committed change into a context folder.
//
// A gathering agent finds the change's pull request, issues, and Tau
// sessions, and exports each relevant one in full. The workflow checks the
// files and writes a manifest. The review workflow runs the same step with
// `gatherContext`, and this script runs it on its own.

import { input } from "@tau/core";
import { preflightModels, startRun, log } from "./lib/workflow.js";
import { MODELS, readInputs, repositoryRoot } from "./lib/review.js";
import { gatherContext } from "./lib/context.js";

const { base, head, workingDirectory } = readInputs(input, {
  depth: false,
  context: false,
});

await preflightModels([MODELS.gather]);

const repo = await repositoryRoot(workingDirectory);
log(`Gather context: ${base.slice(0, 7)}..${head.slice(0, 7)} in ${repo}`);
const run = await startRun({ prefix: "tau-context", workingDirectory: repo });
const { folder, manifest } = await gatherContext(run, { base, head, repo });

run.finish(`Context folder: ${folder}\n\n${manifest}`);
