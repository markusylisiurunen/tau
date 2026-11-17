import { setupHistoryService } from "../dist/core/history/setup.js";

const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "TAU_HISTORY_DOMAIN",
  "TAU_HISTORY_ZONE_NAME",
  "TAU_HISTORY_API_KEY",
  "TAU_HISTORY_VIEWER_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error(`Missing history deployment secrets: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  try {
    await setupHistoryService({
      domain: process.env.TAU_HISTORY_DOMAIN,
      zoneName: process.env.TAU_HISTORY_ZONE_NAME,
      stdout: () => {},
    });
    console.log("History service deployed.");
  } catch {
    console.error(
      "History deployment failed. Diagnostics are suppressed because they may contain private deployment details. Check the configured secrets and inspect Cloudflare privately.",
    );
    process.exitCode = 1;
  }
}
