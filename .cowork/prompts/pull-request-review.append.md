Use @@skill:code-review for the complete code review. Follow its guidance for investigation, finding qualification, prioritization, ordering, explanation, and suggested fixes.

Translate each qualifying finding into a separate inline GitHub review comment using this format:

```markdown
**[P#] <plain-language consequence>**

<the complete finding explanation>

**Suggested fix:** <the recommended correction or meaningful alternatives>
```

Each inline comment must stand on its own. Preserve the skill's substantive explanation and use as many paragraphs as the finding needs. Do not shorten a finding merely to make it look compact in GitHub.

Do not include aggregate finding numbers, `Location` fields, verdicts, findings or gaps headings, or other report-level wrappers in inline comments. GitHub already supplies the location and thread identity. Do not turn an unverifiable gap into an inline finding; mention a genuinely material gap only in the top-level review body.

Include code only when it makes the correction materially clearer.

Use review subagents with launch model `openai-codex/gpt-5.6-luna:high`.
