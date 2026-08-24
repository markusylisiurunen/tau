import { isValidElement, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import { Switch } from "./switch.js";
import "./markdown_content.css";

type MarkdownContentProps = {
  content: string;
  className?: string;
  variant?: "guide" | "thread";
};

type MarkdownCodeBlockProps = {
  className?: string;
  children?: React.ReactNode;
};

type MarkdownCodeChildProps = {
  className?: string;
  children?: React.ReactNode;
};

const highlightedCodeCache = new Map<string, Promise<string | null>>();

const codeLanguageLabels: Readonly<Record<string, string>> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON with Comments",
  jsx: "JSX",
  kotlin: "Kotlin",
  markdown: "Markdown",
  md: "Markdown",
  php: "PHP",
  plaintext: "Plain text",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  text: "Plain text",
  ts: "TypeScript",
  tsx: "TSX",
  txt: "Plain text",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
};

function MarkdownCodeBlock({ className, children }: MarkdownCodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? "text";
  const languageLabel = codeLanguageLabels[language.toLowerCase()] ?? language;
  const code = String(children ?? "").replace(/\n$/, "");

  useEffect(() => {
    let cancelled = false;
    setHtml(null);

    void highlightCodeBlock(code, language).then((result) => {
      if (!cancelled) {
        setHtml(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const highlightedCode =
    html === null ? (
      <pre>
        <code>{children}</code>
      </pre>
    ) : (
      <div dangerouslySetInnerHTML={{ __html: html }} />
    );

  return (
    <div
      className={`markdown-code-block${wrap ? " markdown-code-block-wrap" : ""}`}
    >
      <div className="markdown-code-block-header">
        <span className="markdown-code-block-language">{languageLabel}</span>
        <Switch checked={wrap} label="Wrap" onChange={setWrap} />
      </div>
      <div className="markdown-code-block-content">{highlightedCode}</div>
    </div>
  );
}

async function highlightCodeBlock(
  code: string,
  language: string,
): Promise<string | null> {
  const cacheKey = `${language}\u0000${code}`;
  const cached = highlightedCodeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const highlightPromise = renderHighlightedCode(code, language).catch(
    () => null,
  );
  highlightedCodeCache.set(cacheKey, highlightPromise);
  return highlightPromise;
}

async function renderHighlightedCode(
  code: string,
  language: string,
): Promise<string> {
  try {
    return await codeToHtml(code, {
      lang: language,
      theme: "github-dark-default",
    });
  } catch {
    return codeToHtml(code, {
      lang: "text",
      theme: "github-dark-default",
    });
  }
}

export function MarkdownContent({
  content,
  className,
  variant,
}: MarkdownContentProps) {
  const resolvedClassName = [
    "markdown-content",
    variant ? `markdown-content-${variant}` : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={resolvedClassName}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          table({ children }) {
            return (
              <div className="markdown-table-scroll">
                <table>{children}</table>
              </div>
            );
          },
          pre({ children }) {
            if (isValidElement(children)) {
              const { className: codeClassName, children: codeChildren } =
                children.props as MarkdownCodeChildProps;
              return (
                <MarkdownCodeBlock className={codeClassName}>
                  {codeChildren}
                </MarkdownCodeBlock>
              );
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
