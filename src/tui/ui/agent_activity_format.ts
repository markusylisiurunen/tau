export function formatAgentOutputText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine ? `> ${firstLine}` : undefined;
}

export function formatToolActivityText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("bash running: ")) {
    return `$ ${trimmed.slice("bash running: ".length)}`;
  }
  if (trimmed.startsWith("bash failed: ")) {
    return trimmed.replace(/^bash failed:\s*/, "$ (failed): ");
  }
  if (trimmed.startsWith("bash blocked: ")) {
    return trimmed.replace(/^bash blocked:\s*/, "$ (blocked): ");
  }
  if (trimmed.startsWith("bash aborted: ")) {
    return trimmed.replace(/^bash aborted:\s*/, "$ (aborted): ");
  }
  if (trimmed.startsWith("bash: ")) {
    return trimmed.replace(/^bash:\s*/, "$ (error): ");
  }
  if (trimmed.startsWith("edit: ")) {
    return `edit ${trimmed.slice("edit: ".length)}`;
  }
  if (trimmed.startsWith("write: ")) {
    return `write ${trimmed.slice("write: ".length)}`;
  }
  if (trimmed.startsWith("view image: ")) {
    return `view image ${trimmed.slice("view image: ".length)}`;
  }
  if (trimmed.startsWith("view_image: ")) {
    return `view image error ${trimmed.slice("view_image: ".length)}`;
  }
  if (trimmed.startsWith("tool blocked: write ")) {
    return `write blocked ${trimmed.slice("tool blocked: write ".length)}`;
  }
  if (trimmed.startsWith("tool blocked: edit ")) {
    return `edit blocked ${trimmed.slice("tool blocked: edit ".length)}`;
  }
  if (trimmed.startsWith("tool blocked: view image ")) {
    return `view image blocked ${trimmed.slice("tool blocked: view image ".length)}`;
  }
  if (trimmed.startsWith("web failed: ")) {
    return trimmed;
  }
  if (trimmed.startsWith("web blocked: ")) {
    return trimmed;
  }
  if (trimmed.startsWith("web: ")) {
    return `web ${trimmed.slice("web: ".length)}`;
  }

  return undefined;
}

export function formatAgentActivityText(text: string): string | undefined {
  const toolText = formatToolActivityText(text);
  if (toolText) {
    return toolText;
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("agent failed: ")) {
    const line = trimmed.slice("agent failed: ".length).trim();
    return line ? `agent failed: ${line}` : "agent failed";
  }

  if (trimmed.startsWith("agent: ")) {
    const line = trimmed.slice("agent: ".length).trim();
    return line ? `> ${line}` : undefined;
  }

  return undefined;
}
