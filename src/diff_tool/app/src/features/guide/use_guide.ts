import { useCallback, useEffect, useRef, useState } from "react";
import { generateGuide, operateGuide, saveGuideComment } from "../../api.js";
import type {
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
} from "../../types.js";
import type { ReviewSession } from "../review/use_review_session.js";

type GuideControllerOptions = Pick<
  ReviewSession,
  "bootstrap" | "reviewState" | "setGuideLoading" | "syncReviewState"
>;

export type PendingGuideTopic =
  { id: string; kind: "add" } | { id: string; kind: "revise"; topicId: string };

export type PendingGuideQuestion = {
  id: string;
  question: string;
};

export function useGuide({
  bootstrap,
  reviewState,
  setGuideLoading,
  syncReviewState,
}: GuideControllerOptions) {
  const guideRequestedRef = useRef(false);
  const pendingOperationIdRef = useRef(0);
  const [pendingTopics, setPendingTopics] = useState<PendingGuideTopic[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<
    PendingGuideQuestion[]
  >([]);

  const requestGuide = useCallback(() => {
    setGuideLoading(true);
    void syncReviewState(generateGuide(), {
      onError: () => {
        guideRequestedRef.current = false;
        setGuideLoading(false);
      },
    });
  }, [setGuideLoading, syncReviewState]);

  const runGuideOperation = useCallback(
    (operation: DiffToolGuideOperation) => {
      const pendingId = `guide-operation-${pendingOperationIdRef.current++}`;
      if (operation.kind === "topic.add") {
        setPendingTopics((topics) => [
          ...topics,
          { id: pendingId, kind: "add" },
        ]);
      } else if (operation.kind === "topic.revise") {
        setPendingTopics((topics) => [
          ...topics,
          { id: pendingId, kind: "revise", topicId: operation.topicId },
        ]);
      } else if (operation.kind === "question.ask") {
        setPendingQuestions((questions) => [
          ...questions,
          { id: pendingId, question: operation.question },
        ]);
      }

      setGuideLoading(true);
      void syncReviewState(operateGuide(operation), {
        onError: () => {
          setGuideLoading(false);
        },
      }).finally(() => {
        if (
          operation.kind === "topic.add" ||
          operation.kind === "topic.revise"
        ) {
          setPendingTopics((topics) =>
            topics.filter((topic) => topic.id !== pendingId),
          );
        } else if (operation.kind === "question.ask") {
          setPendingQuestions((questions) =>
            questions.filter((question) => question.id !== pendingId),
          );
        }
      });
    },
    [setGuideLoading, syncReviewState],
  );

  const saveComment = useCallback(
    (target: DiffToolGuideCommentTarget, body: string) => {
      void syncReviewState(saveGuideComment({ target, body }));
    },
    [syncReviewState],
  );

  useEffect(() => {
    if (
      !bootstrap ||
      reviewState.guide.orientation ||
      guideRequestedRef.current
    ) {
      return;
    }

    guideRequestedRef.current = true;
    requestGuide();
  }, [bootstrap, requestGuide, reviewState.guide.orientation]);

  return {
    pendingTopics,
    pendingQuestions,
    requestGuide,
    runGuideOperation,
    saveComment,
  };
}
