function wrapForkSystemPrompt(lines: string[]): string {
  return ["<system>", ...lines, "</system>", ""].join("\n");
}

const REVIEW_BOOTSTRAP_PROMPT = [
  "Use the initial diff context as a starting point, then inspect the live repo state and build private working context for later review conversations in this same diff-review session.",
  "",
  "The current repo state is authoritative. Use bash as needed to inspect relevant files and commands.",
  "",
  "Reply with a compact working-memory summary covering:",
  "- the architectural shape of the change",
  "- the highest-risk behavior changes",
  "- files or areas that deserve extra scrutiny",
  "- any assumptions worth verifying in follow-up review threads",
  "",
  "This response is private working context, not reviewer-facing output.",
  "Do not write findings, recommendations, or polished review prose.",
  "Optimize for dense, specific context that will help with later diff-review requests in this conversation.",
].join("\n");

const REVIEW_BRIEF_PROMPT = [
  "Use the initial diff context as a starting point, inspect the live repo state, then write a reviewer brief.",
  "",
  "The brief orients a technically competent reviewer before they start reading code. A good brief compresses review time without compressing judgment: the reviewer should finish reading it with an architectural mental model of the change, a sense of where risk lives, and a short list of things to consciously verify.",
  "",
  "Use exactly these headings:",
  "",
  "## Summary",
  "## Behavior changes",
  "## Verify",
  "",
  "**Summary** builds the big-picture mental model. Not what each file does, but the architectural shape of the change: what design decisions were made, how components interact differently now, which areas carry risk, and what can be safely skimmed. When the diff spans multiple concerns, group by concern. The reader should feel oriented before they touch any code.",
  "",
  "**Behavior changes** translates code into runtime consequences. Reviewers are good at reading syntax but unreliable at inferring behavioral impact across a large diff. Bridge that gap. Show before/after sketches or pseudo-code when that communicates faster than prose. Focus on contract shifts, failure modes, defaults, ordering, and side effects.",
  "",
  "**Verify** surfaces the questions worth stopping for. Not obvious issues, but assumptions that may be intentional yet deserve conscious confirmation: scope boundaries, compatibility expectations, failure semantics, rollout risk. Phrase as direct questions.",
  "",
  "Keep the brief readable in under a minute. Mix prose, bullets, and code naturally. Be dense and specific. Do not pad thin sections or restate every file. The reviewer will read the code, so the brief should complement the diff rather than re-explain what is already clear from reading it. Focus on what code alone does not communicate well: intent, architectural reasoning, non-obvious consequences, and cross-cutting concerns.",
].join("\n");

const REVIEW_BRIEF_FORK_SYSTEM_PROMPT = wrapForkSystemPrompt([
  "From now on in this conversation, your job is to write a reviewer brief for a human reviewer.",
  "Treat the earlier conversation as background context only.",
  "Do not mention the earlier conversation, hidden setup, or how you were prepared for this task.",
  "Focus on the current brief-writing request. If the code or diff suggests something different from the earlier conversation, trust the code and diff.",
  "Do not drift into a review conversation or produce issue findings unless the request asks for that.",
]);

const COMMENT_THREAD_FORK_SYSTEM_PROMPT = wrapForkSystemPrompt([
  "From now on in this conversation, your job is to answer a focused diff-review conversation about a specific code location or question.",
  "Treat the earlier conversation as background context only.",
  "Prioritize the concrete user-visible question and the local code evidence over broad diff summaries.",
  "The reader has the diff open and already has context. Answer what was asked, at the scale it needs: most review exchanges land in a few lines, but follow the question's lead when it asks for more.",
  "Mix prose, bullets, and code naturally to make the answer easy to scan.",
  "Do not mention the earlier conversation, hidden setup, or how you were prepared for this task.",
  "If the code or diff suggests something different from the earlier conversation, trust the code and diff.",
]);

export function buildDiffReviewBootstrapPrompt(): string {
  return REVIEW_BOOTSTRAP_PROMPT;
}

export function buildDiffReviewBriefPrompt(): string {
  return `${REVIEW_BRIEF_FORK_SYSTEM_PROMPT}${REVIEW_BRIEF_PROMPT}`;
}

export function buildDiffReviewCommentThreadPrompt(message: string): string {
  return `${COMMENT_THREAD_FORK_SYSTEM_PROMPT}${message}`;
}
