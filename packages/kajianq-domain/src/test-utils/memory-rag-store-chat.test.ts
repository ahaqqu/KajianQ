import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { StoreError } from "@app/infra";
import { memoryChatMethods } from "./memory-rag-store-chat";

/**
 * The memory stand-in's uuid gate (#312). `getChatSessionUser` models the
 * `chat_sessions.id` column's cast: an id the column cannot hold fails with
 * `StoreError` kind "constraint", exactly as the real adapter's `${id}::uuid`
 * cast raises (SQLSTATE 22P02). These rows pin the ONE form where the stand-in
 * is deliberately tighter than the column — the extra hyphen PostgreSQL accepts
 * after any group of four digits (QA #289 probe 8: `7b1a-712f-3990-46ce-9964-4eb344a867c5`
 * is PG-legal and names an existing row) while `uuidShaped`'s leading fixed
 * 8-hex group admits no inner hyphen.
 *
 * That divergence is inert today only because `ChatSessionIdSchema` refuses the
 * spelling before any store call (pinned in `packages/contracts/src/chat.test.ts`).
 * The stand-in's own verdict is pinned here so that loosening `uuidShaped` to
 * PostgreSQL's rule — or widening the schema into this form — is visible rather
 * than silent, and so the neighbouring canonical spelling stays a live control.
 * The extra hyphen is the INERT divergence; the same `Map` has a REACHABLE one —
 * it keys on the exact spelling it was given, so an uppercase lookup misses a
 * lowercase-seeded row where the real `uuid` column answers it — tracked in #315.
 *
 * Mutation this row pins: in `memory-rag-store-chat.ts`, relax `uuidShaped` to
 * the column's own rule — e.g.
 * `/^[{]?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}[}]?$/i`
 * — and the extra-hyphen row reddens while the canonical control stays green.
 */

const SESSION_ID = "7b1a712f-3990-46ce-9964-4eb344a867c5";

const storeWithOneSession = () =>
  memoryChatMethods({
    chatSessions: new Map([[SESSION_ID, "user-1"]]),
    chatMessages: new Map(),
  });

describe("memory RagStore uuid gate (#312)", () => {
  it("finds the session for the canonical spelling (the live control)", async () => {
    const owner = await Effect.runPromise(storeWithOneSession().getChatSessionUser(SESSION_ID));
    expect(owner).toBe("user-1");
  });

  it("refuses the Postgres-legal extra-hyphen spelling with a constraint error", async () => {
    // The verdict the schema currently keeps unreachable: PostgreSQL would take
    // this spelling, the stand-in refuses it, and only the boundary stops the
    // disagreement from ever being observed.
    const failure = await Effect.runPromise(
      storeWithOneSession()
        .getChatSessionUser("7b1a-712f-3990-46ce-9964-4eb344a867c5")
        .pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(StoreError);
    expect(failure.kind).toBe("constraint");
  });
});
