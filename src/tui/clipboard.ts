import { spawn } from "node:child_process";

type ClipboardProvider = {
  command: string;
  args: string[];
};

const DARWIN_PROVIDERS: ClipboardProvider[] = [{ command: "pbcopy", args: [] }];
const LINUX_PROVIDERS: ClipboardProvider[] = [
  { command: "wl-copy", args: [] },
  { command: "xclip", args: ["-selection", "clipboard"] },
  { command: "xsel", args: ["--clipboard", "--input"] },
];

function getProvidersForPlatform(platform: NodeJS.Platform): ClipboardProvider[] {
  if (platform === "darwin") {
    return DARWIN_PROVIDERS;
  }

  if (platform === "linux") {
    return LINUX_PROVIDERS;
  }

  return [];
}

function formatProvider(provider: ClipboardProvider): string {
  return [provider.command, ...provider.args].join(" ");
}

async function runClipboardProvider(provider: ClipboardProvider, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(provider.command, provider.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let settled = false;
    let stderr = "";

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on("error", (error) => {
      settleReject(error as Error);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.stdin?.on("error", (error) => {
      settleReject(error as Error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        settleResolve();
        return;
      }

      const details = stderr.trim();
      const exitDetails = details ? `: ${details}` : "";
      settleReject(new Error(`${formatProvider(provider)} exited with code ${code}${exitDetails}`));
    });

    child.stdin?.end(text);
  });
}

function buildMissingProviderError(
  platform: NodeJS.Platform,
  providers: ClipboardProvider[],
  errors: string[],
): Error {
  const providerNames = providers.map((provider) => provider.command).join(", ");
  const attempts = errors.length > 0 ? ` Attempts: ${errors.join(" | ")}` : "";

  if (platform === "darwin") {
    return new Error(
      `failed to copy text to clipboard: missing clipboard provider. Ensure pbcopy is available.${attempts}`,
    );
  }

  if (platform === "linux") {
    return new Error(
      `failed to copy text to clipboard: missing clipboard provider. Install one of: ${providerNames}.${attempts}`,
    );
  }

  return new Error(
    `failed to copy text to clipboard: missing clipboard provider. Unsupported platform: ${platform}.${attempts}`,
  );
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const providers = getProvidersForPlatform(process.platform);
  if (providers.length === 0) {
    throw buildMissingProviderError(process.platform, providers, []);
  }

  const errors: string[] = [];

  for (const provider of providers) {
    try {
      await runClipboardProvider(provider, text);
      return;
    } catch (error) {
      const message = (error as Error).message;
      errors.push(`${formatProvider(provider)} (${message})`);
    }
  }

  throw buildMissingProviderError(process.platform, providers, errors);
}
