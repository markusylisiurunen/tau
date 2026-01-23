import { builtinThemes } from "../../core/config/builtin_themes.js";
import { PALETTE_TOKEN_NAMES, type PaletteTokenName } from "../ui/theme/index.js";
import type { ExportEntry, ExportMetadata, ExportToolCall } from "./types.js";

const defaultTheme = builtinThemes.find((theme) => theme.id === "gold");
if (!defaultTheme) {
  throw new Error("missing builtin theme: gold");
}

const paletteByName = new Map<PaletteTokenName, string>(
  PALETTE_TOKEN_NAMES.map((name) => {
    const value = defaultTheme.tokens[name];
    if (!value) {
      throw new Error(`missing palette token: ${name}`);
    }
    return [name, value] as const;
  }),
);

function color(name: PaletteTokenName): string {
  const value = paletteByName.get(name);
  if (!value) {
    throw new Error(`missing palette token: ${name}`);
  }
  return value;
}

const HTML_EXPORT_COLORS = {
  bg: "hsl(26 8% 8%)",
  panel: "hsl(26 8% 12%)",
  user: "hsl(26 8% 16%)",
  assistant: "hsl(26 8% 10%)",
  tool: "hsl(26 8% 12%)",
  border: "hsl(26 8% 18%)",
  text: "hsl(26 10% 86%)",
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestamp(timestamp?: number): string | null {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleString().toLowerCase();
  } catch {
    return null;
  }
}

function renderToolCalls(toolCalls: ExportToolCall[], baseId: string): string {
  if (toolCalls.length === 0) return "";

  const formatted = toolCalls
    .map((call) => {
      const args =
        call.arguments === undefined ? "" : (JSON.stringify(call.arguments, null, 2) ?? "");
      const header = `tool: ${call.name}`;
      return args.trim().length > 0 ? `${header}\n${args}` : header;
    })
    .join("\n\n");

  const contentId = `${baseId}-tool-calls`;
  const isOpen = toolCalls.length > 0 ? " open" : "";
  return [
    `<details class="tool-calls"${isOpen}>`,
    `  <summary>tool calls (${toolCalls.length})</summary>`,
    `  <pre id="${contentId}" class="tool-calls-text">${escapeHtml(formatted)}</pre>`,
    `</details>`,
  ].join("\n");
}

function renderEntry(entry: ExportEntry, index: number): string {
  const baseId = `entry-${index}`;
  const timestamp = formatTimestamp(entry.timestamp);
  const timestampHtml = timestamp ? `<span class="timestamp">${escapeHtml(timestamp)}</span>` : "";

  if (entry.kind === "user") {
    const textId = `${baseId}-text`;
    const text = escapeHtml(entry.text);
    return [
      `<article class="entry user">`,
      `  <div class="entry-header">`,
      `    <div class="meta">${timestampHtml}</div>`,
      `    <button class="copy-btn" data-copy-target="${textId}" data-label="copy">copy</button>`,
      `  </div>`,
      `  <pre id="${textId}" class="message-text copy-target">${text}</pre>`,
      `</article>`,
    ].join("\n");
  }

  if (entry.kind === "assistant") {
    const textId = `${baseId}-text`;
    const hasText = entry.text.trim().length > 0;
    const toolCallsHtml = renderToolCalls(entry.toolCalls, baseId);
    const toolCallsId = entry.toolCalls.length > 0 ? `${baseId}-tool-calls` : null;
    const copyTargetId = hasText ? textId : toolCallsId;

    const header = [
      `<div class="entry-header">`,
      `  <div class="meta">${timestampHtml}</div>`,
      copyTargetId
        ? `  <button class="copy-btn" data-copy-target="${copyTargetId}" data-label="copy">copy</button>`
        : "",
      `</div>`,
    ]
      .filter((line) => line !== "")
      .join("\n");

    const textBlock = hasText
      ? `<pre id="${textId}" class="message-text copy-target">${escapeHtml(entry.text)}</pre>`
      : "";

    return [
      `<article class="entry assistant">`,
      `  ${header}`,
      textBlock ? `  ${textBlock}` : "",
      toolCallsHtml ? `  ${toolCallsHtml}` : "",
      `</article>`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  const outputId = `${baseId}-tool-output`;
  const callId = `${baseId}-tool-call`;
  const status = entry.isError ? "error" : "ok";
  const metaParts = [escapeHtml(entry.toolName)];
  if (timestamp) metaParts.push(escapeHtml(timestamp));
  const callText = entry.toolCall
    ? [
        `tool: ${entry.toolCall.name}`,
        entry.toolCall.arguments === undefined
          ? ""
          : (JSON.stringify(entry.toolCall.arguments, null, 2) ?? ""),
      ]
        .filter((line) => line !== "")
        .join("\n")
    : "";

  return [
    `<article class="entry tool ${status}">`,
    `  <div class="entry-header">`,
    `    <div class="meta">${metaParts.join(" · ")}</div>`,
    `    <button class="copy-btn" data-copy-target="${outputId}" data-label="copy">copy</button>`,
    `  </div>`,
    callText
      ? [
          `  <details class="tool-call" open>`,
          `    <summary>tool call</summary>`,
          `    <pre id="${callId}" class="tool-call-text copy-target">${escapeHtml(callText)}</pre>`,
          `  </details>`,
        ].join("\n")
      : "",
    `  <details class="tool-output">`,
    `    <summary>${entry.isError ? "tool output (error)" : "tool output"}</summary>`,
    `    <pre id="${outputId}" class="tool-output-text copy-target">${escapeHtml(entry.text)}</pre>`,
    `  </details>`,
    `</article>`,
  ].join("\n");
}

export function renderHtmlExport(entries: ExportEntry[], metadata: ExportMetadata = {}): string {
  const title = metadata.title ?? "tau chat export";
  const generatedAt = metadata.generatedAt ?? Date.now();
  const generatedAtLabel = new Date(generatedAt).toLocaleString().toLowerCase();
  const total = entries.length;
  const counts = entries.reduce(
    (acc, entry) => {
      acc[entry.kind] += 1;
      return acc;
    },
    { user: 0, assistant: 0, tool: 0 },
  );

  const body = entries.map((entry, index) => renderEntry(entry, index)).join("\n\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    "  <style>",
    "    :root {",
    `      --bg: ${HTML_EXPORT_COLORS.bg};`,
    `      --panel: ${HTML_EXPORT_COLORS.panel};`,
    `      --user: ${HTML_EXPORT_COLORS.user};`,
    `      --assistant: ${HTML_EXPORT_COLORS.assistant};`,
    `      --tool: ${HTML_EXPORT_COLORS.tool};`,
    `      --border: ${HTML_EXPORT_COLORS.border};`,
    `      --text: ${HTML_EXPORT_COLORS.text};`,
    `      --muted: ${color("textMuted")};`,
    `      --accent: ${color("brandAccent")};`,
    `      --link: ${color("linkText")};`,
    `      --error: ${color("statusError")};`,
    "    }",
    "    * { box-sizing: border-box; }",
    "    body {",
    "      margin: 0;",
    "      background: var(--bg);",
    "      color: var(--text);",
    '      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;',
    "      font-size: 13px;",
    "      line-height: 1.45;",
    "    }",
    "    h1, h2, h3, p {",
    "      font-size: inherit;",
    "      font-weight: 400;",
    "      margin: 0;",
    "    }",
    "    .page {",
    "      max-width: 920px;",
    "      margin: 0 auto;",
    "      padding: 16px 18px 24px;",
    "    }",
    "    header {",
    "      display: grid;",
    "      gap: 2px;",
    "      padding: 6px 0 8px;",
    "      margin-bottom: 6px;",
    "    }",
    "    .title {",
    "      color: var(--accent);",
    "      letter-spacing: 0.08em;",
    "    }",
    "    .subtitle, .stats {",
    "      color: var(--muted);",
    "    }",
    "    .entry {",
    "      padding: 6px 10px;",
    "      border-top: 1px solid var(--border);",
    "    }",
    "    .entry:first-child {",
    "      border-top: 0;",
    "    }",
    "    .entry.user { background: var(--user); }",
    "    .entry.assistant { background: transparent; }",
    "    .entry.tool { background: var(--tool); }",
    "    .entry.tool.error { border-top-color: var(--error); }",
    "    .entry-header {",
    "      display: flex;",
    "      align-items: center;",
    "      gap: 8px;",
    "      margin-bottom: 2px;",
    "    }",
    "    .meta {",
    "      color: var(--muted);",
    "      flex: 1;",
    "    }",
    "    .copy-btn {",
    "      border: 0;",
    "      background: transparent;",
    "      color: var(--accent);",
    "      padding: 0;",
    "      cursor: pointer;",
    "      opacity: 0.65;",
    "    }",
    "    .entry:hover .copy-btn {",
    "      opacity: 1;",
    "    }",
    "    .copy-btn.copied {",
    "      color: var(--text);",
    "    }",
    "    .message-text, .tool-output-text, .tool-calls-text, .tool-call-text {",
    "      margin: 0;",
    "      white-space: pre-wrap;",
    "      word-break: break-word;",
    "      border: 0;",
    "      padding: 0;",
    "      background: transparent;",
    "    }",
    "    details {",
    "      margin-top: 4px;",
    "    }",
    "    summary {",
    "      cursor: pointer;",
    "      color: var(--muted);",
    "      margin-bottom: 3px;",
    "      list-style: none;",
    "    }",
    "    summary::marker {",
    '      content: "";',
    "    }",
    "    summary::before {",
    '      content: "▸ ";',
    "      color: var(--muted);",
    "    }",
    "    details[open] summary::before {",
    '      content: "▾ ";',
    "    }",
    "    .tool-calls-text, .tool-call-text, .tool-output-text {",
    "      padding-left: 10px;",
    "      border-left: 1px solid var(--border);",
    "    }",
    "    .tool-calls summary {",
    "      color: var(--accent);",
    "    }",
    "    main {",
    "      display: flex;",
    "      flex-direction: column;",
    "      gap: 0;",
    "    }",
    "    main::before {",
    '      content: "";',
    "      display: block;",
    "      border-top: 1px solid var(--border);",
    "      margin-bottom: 4px;",
    "    }",
    "    a {",
    "      color: var(--link);",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    '  <div class="page">',
    "    <header>",
    `      <h1 class="title">${escapeHtml(title)}</h1>`,
    `      <p class="subtitle">generated ${escapeHtml(generatedAtLabel)}</p>`,
    `      <div class="stats">${total} entries · ${counts.user} user · ${counts.assistant} assistant · ${counts.tool} tool</div>`,
    "    </header>",
    "    <main>",
    body,
    "    </main>",
    "  </div>",
    "  <script>",
    "    function copyText(text) {",
    "      if (navigator.clipboard && window.isSecureContext) {",
    "        return navigator.clipboard.writeText(text);",
    "      }",
    "      return new Promise(function(resolve, reject) {",
    "        try {",
    "          var textarea = document.createElement('textarea');",
    "          textarea.value = text;",
    "          textarea.setAttribute('readonly', '');",
    "          textarea.style.position = 'fixed';",
    "          textarea.style.top = '-1000px';",
    "          document.body.appendChild(textarea);",
    "          textarea.select();",
    "          var success = document.execCommand('copy');",
    "          document.body.removeChild(textarea);",
    "          success ? resolve() : reject(new Error('copy failed'));",
    "        } catch (err) {",
    "          reject(err);",
    "        }",
    "      });",
    "    }",
    "    function flashButton(button) {",
    "      var label = button.getAttribute('data-label') || 'copy';",
    "      button.textContent = 'copied';",
    "      button.classList.add('copied');",
    "      window.setTimeout(function() {",
    "        button.textContent = label;",
    "        button.classList.remove('copied');",
    "      }, 1200);",
    "    }",
    "    document.querySelectorAll('[data-copy-target]').forEach(function(button) {",
    "      button.addEventListener('click', function() {",
    "        var targetId = button.getAttribute('data-copy-target');",
    "        var target = targetId ? document.getElementById(targetId) : null;",
    "        if (!target) {",
    "          return;",
    "        }",
    "        var text = target.textContent || '';",
    "        copyText(text).then(function() {",
    "          flashButton(button);",
    "        });",
    "      });",
    "    });",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");
}
