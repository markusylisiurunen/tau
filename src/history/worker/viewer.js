function inline(value) {
  const tick = String.fromCharCode(96);
  return value
    .trim()
    .replace(/([\\*_{}[\]<>#+.!|~-])/g, "\\$1")
    .replaceAll(tick, "\\" + tick);
}
function fenced(value) {
  const tick = String.fromCharCode(96);
  const ticks = value.match(new RegExp(tick + "+", "g")) || [];
  const width = Math.max(3, ...ticks.map((run) => run.length + 1));
  const fence = tick.repeat(width);
  return fence + "\n" + value.trim() + "\n" + fence;
}
function cardMarkdown(card) {
  const tool = card.querySelector(".tool-entry");
  if (tool) {
    const name = tool.querySelector("summary span")?.textContent.replace(/^Tool · /, "") || "Tool";
    const outcome = tool.querySelector(".outcome")?.textContent || "";
    const sections = [...tool.querySelectorAll(".tool-section")].map((section) => {
      const heading = section.querySelector("h3")?.textContent || "Details";
      const value = section.querySelector("pre")?.textContent || "";
      return "### " + inline(heading) + "\n\n" + fenced(value);
    });
    return (
      "## Tool: " +
      inline(name) +
      (outcome ? " (" + inline(outcome) + ")" : "") +
      "\n\n" +
      sections.join("\n\n")
    );
  }
  const role = card.querySelector("h2")?.textContent || "Message";
  const content = [...card.querySelectorAll(".content-blocks > *, :scope > pre")]
    .map((block) => {
      return block.dataset.markdown || block.textContent || "";
    })
    .join("\n\n");
  return "## " + inline(role) + "\n\n" + content.trim();
}
function conversationMarkdown() {
  const header = document.querySelector(".conversation-header");
  const title = header?.querySelector("h1")?.textContent || "Conversation";
  const summary = header?.querySelector(".summary")?.textContent;
  const metadata = [...(header?.querySelectorAll(".metadata tr") || [])].map((row) => {
    const key = row.querySelector("th")?.textContent || "";
    const value = row.querySelector("td")?.textContent || "";
    return "- **" + inline(key) + ":** " + inline(value);
  });
  const parts = ["# " + inline(title)];
  if (summary) parts.push(summary.trim());
  if (metadata.length) parts.push(metadata.join("\n"));
  parts.push(...[...document.querySelectorAll(".transcript .entry")].map(cardMarkdown));
  return parts.join("\n\n");
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.copy === "entry") {
    const card = button.closest(".entry");
    if (card) navigator.clipboard.writeText(cardMarkdown(card));
  } else if (button.dataset.copy === "conversation") {
    navigator.clipboard.writeText(conversationMarkdown());
  }
  if (button.dataset.tools === "open" || button.dataset.tools === "close") {
    document.querySelectorAll(".tool-entry").forEach((tool) => {
      tool.open = button.dataset.tools === "open";
    });
  }
});

function initializeTranscript() {
  const transcript = document.querySelector("[data-transcript-url]");
  if (!transcript) return;
  const status = document.querySelector("[data-transcript-status]");
  const retry = document.querySelector("[data-transcript-retry]");
  const controls = document.querySelectorAll(".transcript-actions button");
  const endpoint = transcript.dataset.transcriptUrl;
  let nextUrl = endpoint;
  let loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    status.textContent = "Loading conversation…";
    transcript.setAttribute("aria-busy", "true");
    try {
      while (nextUrl) {
        const response = await fetch(nextUrl, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const page = await response.json();
        transcript.insertAdjacentHTML("beforeend", page.html);
        nextUrl =
          page.nextCursor === null
            ? null
            : `${endpoint}?cursor=${encodeURIComponent(page.nextCursor)}`;
      }
      status.textContent = transcript.children.length
        ? "Conversation loaded."
        : "This conversation has no transcript entries.";
      for (const control of controls) control.disabled = false;
    } catch {
      status.textContent = "Failed to load the full conversation. Retry to continue loading.";
      retry.hidden = false;
    } finally {
      transcript.setAttribute("aria-busy", "false");
      loading = false;
    }
  }

  retry.addEventListener("click", load);
  void load();
}

initializeTranscript();
