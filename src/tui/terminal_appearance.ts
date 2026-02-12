import { closeSync, openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";
import type { ThemeAppearance } from "../core/config/index.js";

const OSC11_QUERY = "\x1b]11;?\x07";
const OSC11_PREFIX = "\x1b]11;";
const OSC_BEL_TERMINATOR = "\x07";
const OSC_ST_TERMINATOR = "\x1b\\";

type InputStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type ProbeTerminal = {
  input: InputStream;
  write: (data: string) => void;
  cleanup: () => void;
};

export function parseOsc11BackgroundRgb(
  data: string,
): { r: number; g: number; b: number } | undefined {
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

export function classifyTerminalAppearance(rgb: {
  r: number;
  g: number;
  b: number;
}): ThemeAppearance {
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

function extractOsc11Response(buffer: string): string | undefined {
  const prefixIndex = buffer.indexOf(OSC11_PREFIX);
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

async function queryOsc11Background(
  input: InputStream,
  write: (data: string) => void,
  timeoutMs: number,
): Promise<string | undefined> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";
  const wasRaw = input.isRaw ?? false;

  return new Promise((resolve) => {
    const finish = (value: string | undefined) => {
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

      resolve(value);
    };

    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const response = extractOsc11Response(buffer);
      if (response) {
        finish(response);
      }
    };

    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();

    if (input.setRawMode) {
      input.setRawMode(true);
    }

    timer = setTimeout(() => finish(undefined), timeoutMs);

    try {
      write(OSC11_QUERY);
    } catch {
      finish(undefined);
    }
  });
}

export async function detectTerminalAppearance(timeoutMs = 100): Promise<ThemeAppearance> {
  const terminal = createProbeTerminal();
  if (!terminal) {
    return "dark";
  }

  try {
    const response = await queryOsc11Background(terminal.input, terminal.write, timeoutMs);
    if (!response) {
      return "dark";
    }

    const rgb = parseOsc11BackgroundRgb(response);
    if (!rgb) {
      return "dark";
    }

    return classifyTerminalAppearance(rgb);
  } catch {
    return "dark";
  } finally {
    terminal.cleanup();
  }
}
