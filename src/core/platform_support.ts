export function getStartupPlatformError(platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    return "tau supports macOS and Linux. Windows is not supported.";
  }

  return undefined;
}
