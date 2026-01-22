import { arch, platform, release } from "node:os";

export const CODEX_ORIGINATOR = "moo";
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR} (${platform()} ${release()}; ${arch()})`;
