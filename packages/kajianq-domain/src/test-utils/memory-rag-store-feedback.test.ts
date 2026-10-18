import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { createMemoryRagStore } from "./memory-rag-store";

/**
 * The stand-in's feedback-target read resolves the two ids the feedback route
 * accepts — the trace's `message_id` (TEXT, compared exactly, as the adapter's
 * first OR arm does) and a rehydrated chat row id (`chat_messages.id`, uuid,
 * cast and therefore case-insensitive, as the adapter's second arm does). A
 * re-cased chat row id still reaches its answer; a re-cased trace message id
 * stays a miss, exactly as production answers.
 *
 * Mutations these rows pin, in `memory-rag-store-feedback.ts`: drop
 * `canonicalUuid` from the `chatMessages` lookup and the uppercase row reddens
 * (the TEXT arm's miss no longer falls through to the row); lowercase the
 * `traces` lookup and the text-arm row reddens.
 */

const TRACE_MESSAGE_ID = "7b1a712f-3990-46ce-9964-4eb344a867c5";
const TRACE_ROW_ID = "trace-row-1";

/** One assistant answer: a trace plus the chat row that points at it. */
async function storeWithOneAnswer() {
  const store = createMemoryRagStore();
  await Effect.runPromise(
    store.insertAnswerTrace({
      messageId: TRACE_MESSAGE_ID,
      userId: "user-1",
      trace: { id: TRACE_ROW_ID, createdAt: 1_700_000_000_000, events: [] },
    }),
  );
  const chatRowId = await Effect.runPromise(
    store.insertChatMessage({
      sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      role: "assistant",
      content: "Allah Mahahidup.",
      answerTraceId: TRACE_ROW_ID,
    }),
  );
  return { store, chatRowId };
}

describe("memory RagStore feedback target resolves the uuid arm by case", () => {
  it("finds the answer for an UPPERCASE spelling of the chat row id", async () => {
    const { store, chatRowId } = await storeWithOneAnswer();
    const target = await Effect.runPromise(store.getAnswerFeedbackTarget(chatRowId.toUpperCase()));
    expect(target?.messageId).toBe(TRACE_MESSAGE_ID);
    expect(target?.userId).toBe("user-1");
    expect(target?.answerText).toBe("Allah Mahahidup.");
  });

  it("does NOT match the trace's TEXT message_id when only its case differs", async () => {
    const { store } = await storeWithOneAnswer();
    const target = await Effect.runPromise(
      store.getAnswerFeedbackTarget(TRACE_MESSAGE_ID.toUpperCase()),
    );
    expect(target).toBeNull();
  });
});
