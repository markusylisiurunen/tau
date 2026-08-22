import { useEffect, useRef, useState } from "react";
import type {
  DiffToolGuideComment,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideTopic,
} from "../../types.js";
import { Button } from "../../ui/button.js";
import { GuideFeedbackFormCard } from "./guide_feedback_card.js";
import { GuideTopicContent } from "./guide_topic_content.js";
import "./guide_topics.css";

type GuideTopicsProps = {
  topics: DiffToolGuideTopic[];
  comments: DiffToolGuideComment[];
  loading: boolean;
  onOperate: (operation: DiffToolGuideOperation) => void;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function GuideTopics({
  topics,
  comments,
  loading,
  onOperate,
  onComment,
}: GuideTopicsProps) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState(
    () => topics[0]?.id ?? null,
  );
  const requestedTopicCountRef = useRef<number | null>(null);
  const selectedTopic =
    topics.find((topic) => topic.id === selectedTopicId) ?? topics[0];

  useEffect(() => {
    const requestedTopicCount = requestedTopicCountRef.current;
    if (requestedTopicCount === null || topics.length <= requestedTopicCount) {
      return;
    }

    setSelectedTopicId(topics[topics.length - 1]?.id ?? null);
    requestedTopicCountRef.current = null;
  }, [topics]);

  return (
    <section className="guide-section" aria-label="Topics">
      <div className="guide-topic-cloud" aria-label="Guide topics">
        {topics.map((topic) => {
          const active = !requestOpen && topic.id === selectedTopic?.id;
          return (
            <Button
              key={topic.id}
              variant={active ? "default" : "ghost"}
              active={active}
              pill
              aria-pressed={active}
              onClick={() => {
                setSelectedTopicId(topic.id);
                setRequestOpen(false);
              }}
            >
              {topic.label}
            </Button>
          );
        })}
        <Button
          variant={requestOpen ? "default" : "ghost"}
          active={requestOpen}
          muted={!requestOpen}
          pill
          aria-pressed={requestOpen}
          disabled={loading}
          onClick={() => setRequestOpen(true)}
        >
          Ask about…
        </Button>
      </div>

      {requestOpen ? (
        <GuideFeedbackFormCard
          label="Ask about a topic"
          placeholder="Describe the topic you want explained…"
          submitLabel="Ask"
          loading={loading}
          onClose={() => setRequestOpen(false)}
          onSubmit={(request) => {
            requestedTopicCountRef.current = topics.length;
            onOperate({ kind: "topic.add", request });
            setRequestOpen(false);
          }}
        />
      ) : (
        selectedTopic && (
          <GuideTopicContent
            key={selectedTopic.id}
            topic={selectedTopic}
            comments={comments}
            loading={loading}
            onOperate={onOperate}
            onComment={onComment}
          />
        )
      )}
    </section>
  );
}
