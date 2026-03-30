import { DiffToolHttpServer, type StartedDiffToolHttpServer } from "./http_server.js";
import { DiffReviewProtocolClient, parseDiffToolLaunchEnvironment } from "./protocol_client.js";

export type {
  DiffToolBootstrapPayload,
  DiffToolCommentThread,
  DiffToolLineSide,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadMessage,
  StartDiffToolHttpServerOptions,
  StartedDiffToolHttpServer,
} from "./http_server.js";
export { DiffToolHttpServer } from "./http_server.js";
export type { CreateBuiltInDiffToolConfigOptions } from "./launcher.js";
export { createBuiltInDiffToolConfig } from "./launcher.js";
export {
  DiffReviewProtocolClient,
  DiffReviewProtocolClientError,
  DiffToolLaunchEnvironmentError,
  parseDiffToolLaunchEnvironment,
} from "./protocol_client.js";

export type RunBuiltInDiffToolCommandOptions = {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

export async function runBuiltInDiffToolCommand(
  options: RunBuiltInDiffToolCommandOptions = {},
): Promise<void> {
  const launchEnvironment = parseDiffToolLaunchEnvironment(options.env);
  const client = new DiffReviewProtocolClient(launchEnvironment);
  const server = new DiffToolHttpServer({ client });

  let started: StartedDiffToolHttpServer | undefined;
  let shuttingDown = false;
  const requestShutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await server.cancel();
  };

  const onSigInt = () => {
    void requestShutdown();
  };
  const onSigTerm = () => {
    void requestShutdown();
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    started = await server.start();
    const log = options.log ?? ((message: string) => console.log(message));

    log(`tau diff tool listening at ${started.url}`);
    log(`open the url above in a browser to continue the review`);

    await server.waitUntilClosed();
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (!shuttingDown) {
      await server.close();
    }
  }
}
