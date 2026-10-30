/**
 * The chain-evidence barrel: the read (rows, narrators, the trace record) and the
 * rendering that presents them. The two halves are separate files only to stay
 * inside the agentic line cap; consumers take this entry so the split stays an
 * implementation detail.
 */
export * from "./chat-isnad-evidence";
export * from "./chat-isnad-render";
