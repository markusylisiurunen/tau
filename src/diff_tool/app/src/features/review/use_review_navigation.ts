import { useCallback, useRef, useState } from "react";

export type ReviewMode = "guide" | "diff";

export function useReviewNavigation() {
  const [mode, setMode] = useState<ReviewMode>("guide");
  const contentRef = useRef<HTMLElement | null>(null);
  const scrollPositionsRef = useRef<Record<ReviewMode, number>>({
    guide: 0,
    diff: 0,
  });

  const changeMode = useCallback(
    (nextMode: ReviewMode) => {
      if (nextMode === mode) {
        return;
      }

      const content = contentRef.current;
      if (content) {
        scrollPositionsRef.current[mode] = content.scrollTop;
      }
      setMode(nextMode);
      requestAnimationFrame(() => {
        contentRef.current?.scrollTo({
          top: scrollPositionsRef.current[nextMode],
          behavior: "auto",
        });
      });
    },
    [mode],
  );

  const scrollToFile = useCallback(
    (fileId: string, behavior: ScrollBehavior = "smooth") => {
      const content = contentRef.current;
      const element = document.getElementById(`file-${fileId}`);
      if (!content || !element) {
        return;
      }

      const contentBounds = content.getBoundingClientRect();
      const elementBounds = element.getBoundingClientRect();
      const topPadding = Number.parseFloat(
        getComputedStyle(content).paddingTop,
      );
      content.scrollTo({
        top:
          content.scrollTop +
          elementBounds.top -
          contentBounds.top -
          topPadding,
        behavior,
      });
    },
    [],
  );

  return {
    mode,
    contentRef,
    changeMode,
    scrollToFile,
  };
}
