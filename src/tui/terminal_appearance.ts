import { closeSync, openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";
import type { ThemeAppearance } from "../core/config/index.js";

const OSC_FOREGROUND_QUERY = "\x1b]10;?\x07";
const OSC_BACKGROUND_QUERY = "\x1b]11;?\x07";
const OSC_BEL_TERMINATOR = "\x07";
const OSC_ST_TERMINATOR = "\x1b\\";

export type TerminalRgbColor = {
  r: number;
  g: number;
  b: number;
};

export type TerminalColors = {
  foreground: TerminalRgbColor;
  background: TerminalRgbColor;
  appearance: ThemeAppearance;
};

export const FALLBACK_TERMINAL_COLORS: TerminalColors = {
  foreground: { r: 0xd4 / 255, g: 0xd4 / 255, b: 0xd4 / 255 },
  background: { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255 },
  appearance: "dark",
};

const LIGHT_FALLBACK_FOREGROUND: TerminalRgbColor = {
  r: 0x24 / 255,
  g: 0x24 / 255,
  b: 0x24 / 255,
};

type InputStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type ProbeTerminal = {
  input: InputStream;
  write: (data: string) => void;
  cleanup: () => void;
};

type OscColorResponses = {
  foreground?: TerminalRgbColor;
  background?: TerminalRgbColor;
};

export function parseOsc11BackgroundRgb(data: string): TerminalRgbColor | undefined {
  const match = data.match(/rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/);
  if (!match) return undefined;

  const channels = match.slice(1, 4);
  if (channels.length !== 3) return undefined;

  const rRaw = channels[0];
  const gRaw = channels[1];
  const bRaw = channels[2];
  if (!rRaw || !gRaw || !bRaw) return undefined;

  const normalize = (channel: string): number => {
    const max = 16 ** channel.length - 1;
    return Number.parseInt(channel, 16) / max;
  };

  const r = normalize(rRaw);
  const g = normalize(gRaw);
  const b = normalize(bRaw);

  if ([r, g, b].some((channel) => Number.isNaN(channel))) {
    return undefined;
  }

  return { r, g, b };
}

export function classifyTerminalAppearance(rgb: TerminalRgbColor): ThemeAppearance {
  const luminance = rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722;
  return luminance > 0.5 ? "light" : "dark";
}

function createProbeTerminal(): ProbeTerminal | undefined {
  if (!process.stdout.isTTY) {
    return undefined;
  }

  if (process.stdin.isTTY) {
    return {
      input: process.stdin,
      write: (data) => {
        process.stdout.write(data);
      },
      cleanup: () => {},
    };
  }

  try {
    const fd = openSync("/dev/tty", "r+");
    const input = new ReadStream(fd) as InputStream;
    return {
      input,
      write: (data) => {
        writeSync(fd, data);
      },
      cleanup: () => {
        input.destroy();
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return undefined;
  }
}

function extractOscResponse(buffer: string, code: 10 | 11): string | undefined {
  const prefix = `\x1b]${code};`;
  const prefixIndex = buffer.indexOf(prefix);
  if (prefixIndex === -1) return undefined;

  const tail = buffer.slice(prefixIndex);
  const belIndex = tail.indexOf(OSC_BEL_TERMINATOR);
  const stIndex = tail.indexOf(OSC_ST_TERMINATOR);

  if (belIndex === -1 && stIndex === -1) {
    return undefined;
  }

  if (belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)) {
    return tail.slice(0, belIndex + OSC_BEL_TERMINATOR.length);
  }

  return tail.slice(0, stIndex + OSC_ST_TERMINATOR.length);
}

async function queryTerminalColors(
  input: InputStream,
  write: (data: string) => void,
  timeoutMs: number,
): Promise<OscColorResponses> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";
  const responses: OscColorResponses = {};
  const wasRaw = input.isRaw ?? false;

  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      input.removeListener("data", onData);
      input.pause();
      if (input.setRawMode && !wasRaw) {
        input.setRawMode(false);
      }

      resolve(responses);
    };

    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

      if (!responses.foreground) {
        const response = extractOscResponse(buffer, 10);
        responses.foreground = response ? parseOsc11BackgroundRgb(response) : undefined;
      }
      if (!responses.background) {
        const response = extractOscResponse(buffer, 11);
        responses.background = response ? parseOsc11BackgroundRgb(response) : undefined;
      }
      if (responses.foreground && responses.background) {
        finish();
      }
    };

    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();

    if (input.setRawMode) {
      input.setRawMode(true);
    }

    timer = setTimeout(finish, timeoutMs);

    try {
      write(`${OSC_FOREGROUND_QUERY}${OSC_BACKGROUND_QUERY}`);
    } catch {
      finish();
    }
  });
}

export async function detectTerminalColors(timeoutMs = 100): Promise<TerminalColors> {
  const terminal = createProbeTerminal();
  if (!terminal) {
    return FALLBACK_TERMINAL_COLORS;
  }

  try {
    const detected = await queryTerminalColors(terminal.input, terminal.write, timeoutMs);
    const background = detected.background ?? FALLBACK_TERMINAL_COLORS.background;
    const appearance = classifyTerminalAppearance(background);
    const fallbackForeground =
      appearance === "light" ? LIGHT_FALLBACK_FOREGROUND : FALLBACK_TERMINAL_COLORS.foreground;

    return {
      foreground: detected.foreground ?? fallbackForeground,
      background,
      appearance,
    };
  } catch {
    return FALLBACK_TERMINAL_COLORS;
  } finally {
    terminal.cleanup();
  }
}
