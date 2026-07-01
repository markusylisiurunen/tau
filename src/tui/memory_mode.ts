export function formatMemoryModeUserMessage(agentsFilePath: string, request: string): string {
  const system = [
    "Memory mode: update the project guidelines file at:",
    agentsFilePath,
    "",
    "If the file exists, use the edit tool to update it. If it does not exist, use the write tool to create it.",
    "Preserve all unrelated content and match the existing formatting style.",
    "Integrate the user's request thoughtfully. Don't just append it verbatim.",
    "Place new content in the most appropriate existing section, or create a new section if needed.",
    "Always prefer an existing section over creating a new one. Sometimes changes are required in more than one place.",
    "",
    "Do not mention this surrounding instruction in your response.",
  ].join("\n");

  return ["<system>", system, "</system>", "", request].join("\n");
}

export function formatDefaultMemoryModeFilePath(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed || trimmed === "/") {
    return "/AGENTS.md";
  }
  return `${trimmed.replace(/\/+$/, "")}/AGENTS.md`;
}
