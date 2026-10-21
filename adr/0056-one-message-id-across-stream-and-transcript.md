# ADR-0056: An answer's message id is its chat message row id, on the stream and in the transcript

## Decision

An answer has one message identity: the `chat_messages` row id. The chat stream's
`meta.messageId`, the structured citation and trace frames' `messageId`, the
rehydrated transcript message's `id`, and a feedback request's `messageId` are that
one value, and `answer_traces.message_id` references it. A client joins a streamed
answer to its persisted history directly — no id translation, no second field.

The answer trace's own identity is its row id (`meta.traceId`, the value
`chat_messages.answer_trace_id` holds). That is a distinct space that names the
evidence, never another name for the message.

The message is minted once and written into both rows, so the identity is a fact of
the write rather than a convention two writers must remember.

## Why

The answer is the user-visible object: the transcript renders it, feedback anchors to
it, and erasure deletes it with the user. The trace is evidence attached to that
object, and the trace's message reference exists to find the evidence from the
message — so it has to name the message. Two ids that both look like message ids and
silently disagree force every client to know which space it holds, and the failure is
invisible because nothing in either payload says which one it is.

Rejected: emitting the trace's reference as `messageId` while the transcript returns
the row id (the join stays broken); carrying both under distinct names (the client
still chooses, and one object keeps two identities); minting a third id for the
stream (a third space, no new truth).

The store does not enforce the equality as a foreign key: a failed run's trace
persists without a message row, because there is no answer to address. The single
write path holds the invariant instead, pinned by tests that join the live frame to
the rehydrated transcript.

## Consequences

- The message write accepts the caller's row id, and the same value feeds the trace's
  message reference, so the pair cannot drift where both are produced.
- The feedback target keeps resolving either address: the store does not constrain the
  two columns equal, and both identifiers a client can hold reach the same canonical
  message row.
- The wire shapes do not change, so no client versioning is needed; what changes is
  that the join the contract implied is now true.
