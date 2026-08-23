import { isValidElement, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { codeToHtml } from "shiki";
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

function MarkdownCodeBlock({ className, children }: MarkdownCodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? "text";
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

  if (html === null) {
    return (
      <pre>
        <code>{children}</code>
      </pre>
    );
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
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
        components={{
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
