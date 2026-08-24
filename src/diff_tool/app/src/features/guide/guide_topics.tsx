import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiffToolGuideComment,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideTopic,
} from "../../types.js";
import { Button } from "../../ui/button.js";
import { GuideFeedbackFormCard } from "./guide_feedback_card.js";
import { GuideTopicContent } from "./guide_topic_content.js";
import type { PendingGuideTopic } from "./use_guide.js";
import "./guide_topics.css";

type GuideTopicsProps = {
  topics: DiffToolGuideTopic[];
  pendingTopics: PendingGuideTopic[];
  comments: DiffToolGuideComment[];
  onOperate: (operation: DiffToolGuideOperation) => void;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function GuideTopics({
  topics,
  pendingTopics,
  comments,
  onOperate,
  onComment,
}: GuideTopicsProps) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState(
    () => topics[0]?.id ?? null,
  );
  const requestedTopicCountRef = useRef<number | null>(null);
  const requestedPendingTopicCountRef = useRef<number | null>(null);
  const pendingAddedTopics = useMemo(
    () => pendingTopics.filter((topic) => topic.kind === "add"),
    [pendingTopics],
  );
  const pendingRevisionTopicIds = useMemo(
    () =>
      new Set(
        pendingTopics.flatMap((topic) =>
          topic.kind === "revise" ? [topic.topicId] : [],
        ),
      ),
    [pendingTopics],
  );
  const selectedPendingTopic = pendingAddedTopics.find(
    (topic) => topic.id === selectedTopicId,
  );
  const selectedTopic = selectedPendingTopic
    ? undefined
    : (topics.find((topic) => topic.id === selectedTopicId) ?? topics[0]);

  useEffect(() => {
    const requestedTopicCount = requestedTopicCountRef.current;
    if (requestedTopicCount === null || topics.length <= requestedTopicCount) {
      return;
    }

    setSelectedTopicId(topics[topics.length - 1]?.id ?? null);
    requestedTopicCountRef.current = null;
  }, [topics]);

  useEffect(() => {
    const requestedPendingTopicCount = requestedPendingTopicCountRef.current;
    if (
      requestedPendingTopicCount === null ||
      pendingAddedTopics.length <= requestedPendingTopicCount
    ) {
      return;
    }

    setSelectedTopicId(
      pendingAddedTopics[pendingAddedTopics.length - 1]?.id ?? null,
    );
    requestedPendingTopicCountRef.current = null;
  }, [pendingAddedTopics]);

  return (
    <section className="guide-section" aria-label="Topics">
      <div className="guide-topic-cloud" aria-label="Guide topics">
        {topics.map((topic) => {
          const active = !requestOpen && topic.id === selectedTopic?.id;
          const updating = pendingRevisionTopicIds.has(topic.id);
          return (
            <Button
              key={topic.id}
              variant={active ? "default" : "ghost"}
              active={active}
              pill
              aria-label={updating ? `${topic.label}, updating` : undefined}
              aria-pressed={active}
              onClick={() => {
                setSelectedTopicId(topic.id);
                setRequestOpen(false);
              }}
            >
              {topic.label}
              {updating && (
                <span className="guide-topic-working-dot" aria-hidden="true" />
              )}
            </Button>
          );
        })}
        {pendingAddedTopics.map((topic) => {
          const active = !requestOpen && topic.id === selectedPendingTopic?.id;
          return (
            <Button
              key={topic.id}
              variant={active ? "default" : "ghost"}
              active={active}
              pill
              aria-label="New topic, generating"
              aria-pressed={active}
              onClick={() => {
                setSelectedTopicId(topic.id);
                setRequestOpen(false);
              }}
            >
              New topic
              <span className="guide-topic-working-dot" aria-hidden="true" />
            </Button>
          );
        })}
        <Button
          variant={requestOpen ? "default" : "ghost"}
          active={requestOpen}
          muted={!requestOpen}
          pill
          aria-pressed={requestOpen}
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
          onClose={() => setRequestOpen(false)}
          onSubmit={(request) => {
            requestedTopicCountRef.current = topics.length;
            requestedPendingTopicCountRef.current = pendingAddedTopics.length;
            onOperate({ kind: "topic.add", request });
            setRequestOpen(false);
          }}
        />
      ) : selectedPendingTopic ? (
        <article className="guide-topic-content" role="status">
          <header className="guide-topic-heading">
            <h3>Generating topic…</h3>
          </header>
          <p className="guide-topic-generating">
            Building a focused explanation for this topic.
          </p>
        </article>
      ) : (
        selectedTopic && (
          <GuideTopicContent
            key={selectedTopic.id}
            topic={selectedTopic}
            comments={comments}
            onOperate={onOperate}
            onComment={onComment}
          />
        )
      )}
    </section>
  );
}
