import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { StoreError } from "@app/infra";
import { memoryChatMethods, type MemoryChatState } from "./memory-rag-store-chat";

/**
 * The memory stand-in's uuid handling: the cast gate and the map key.
 *
 * `getChatSessionUser` models the `chat_sessions.id` column's cast: an id the
 * column cannot hold fails with `StoreError` kind "constraint", exactly as the
 * real adapter's `${id}::uuid` cast raises (SQLSTATE 22P02). These rows pin the
 * ONE form where the stand-in is deliberately tighter than the column — the
 * extra hyphen PostgreSQL accepts after any group of four digits, while
 * `uuidShaped`'s leading fixed 8-hex group admits no inner hyphen. That
 * divergence is inert only because `ChatSessionIdSchema` refuses the spelling
 * before any store call (pinned in `packages/contracts/src/chat.test.ts`); the
 * stand-in's own verdict is pinned here so that loosening `uuidShaped` to
 * PostgreSQL's rule — or widening the schema into this form — is visible rather
 * than silent, and so the neighbouring canonical spelling stays a live control.
 *
 * The column is also CASE-INSENSITIVE, and that difference `v.uuid()` admits
 * (either case of the canonical hyphenated shape) — so the maps key and compare
 * by the column's canonical text form (`canonicalUuid`): an uppercase or
 * mixed-case lookup reaches the row a lowercase seed wrote, exactly as the cast
 * does. `chatMessages` follows the same rule for its message-id key and its
 * `session_id` value.
 *
 * Mutations these rows pin, in `memory-rag-store-chat.ts`: (a) drop
 * `canonicalUuid` from `getChatSessionUser`'s lookup — or from the
 * `insertChatMessage` write and `getChatMessages` filter — and the re-cased row
 * reddens while the canonical control stays green; (b) relax `uuidShaped` to the
 * column's own rule — e.g.
 * `/^[{]?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}[}]?$/i`
 * — and the extra-hyphen row reddens while the canonical control stays green.
 */

const SESSION_ID = "7b1a712f-3990-46ce-9964-4eb344a867c5";
const MESSAGE_ID = "c4e0b0a9-2a41-4f7c-9d3e-8f2a6b1c5d70";

const stateWithOneSession = (): MemoryChatState => ({
  chatSessions: new Map([[SESSION_ID, "user-1"]]),
  chatMessages: new Map(),
});

const storeWithOneSession = () => memoryChatMethods(stateWithOneSession());

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

describe("memory RagStore chat maps compare by the uuid column's canonical text", () => {
  it("finds the session for an UPPERCASE spelling of the seeded id", async () => {
    const owner = await Effect.runPromise(
      storeWithOneSession().getChatSessionUser(SESSION_ID.toUpperCase()),
    );
    expect(owner).toBe("user-1");
  });

  it("finds the session for a MIXED-case spelling of the seeded id", async () => {
    const owner = await Effect.runPromise(
      storeWithOneSession().getChatSessionUser("7b1A712F-3990-46ce-9964-4EB344A867c5"),
    );
    expect(owner).toBe("user-1");
  });

  it("mints a session in canonical form, so a re-cased read-back names it", async () => {
    const state: MemoryChatState = { chatSessions: new Map(), chatMessages: new Map() };
    const methods = memoryChatMethods(state);
    const id = await Effect.runPromise(methods.createChatSession({ userId: "user-1" }));
    expect(id).toBe(id.toLowerCase());
    expect([...state.chatSessions.keys()]).toEqual([id]);
    expect(await Effect.runPromise(methods.getChatSessionUser(id.toUpperCase()))).toBe("user-1");
  });

  it("returns a session's messages for an UPPERCASE session-id spelling", async () => {
    const state: MemoryChatState = {
      chatSessions: new Map([[SESSION_ID, "user-1"]]),
      chatMessages: new Map([
        [
          MESSAGE_ID,
          {
            sessionId: SESSION_ID,
            role: "user",
            content: "Apa itu Ayat Kursi?",
            answerTraceId: null,
          },
        ],
      ]),
    };
    const rows = await Effect.runPromise(
      memoryChatMethods(state).getChatMessages(SESSION_ID.toUpperCase()),
    );
    expect(rows.map((m) => m.content)).toEqual(["Apa itu Ayat Kursi?"]);
  });

  it("stores a message's session_id canonically, so it reads back under either spelling", async () => {
    const state: MemoryChatState = { chatSessions: new Map(), chatMessages: new Map() };
    const methods = memoryChatMethods(state);
    await Effect.runPromise(
      methods.insertChatMessage({
        sessionId: SESSION_ID.toUpperCase(),
        role: "user",
        content: "Apa itu Ayat Kursi?",
        answerTraceId: null,
      }),
    );
    const rows = await Effect.runPromise(methods.getChatMessages(SESSION_ID));
    expect(rows.map((m) => [m.sessionId, m.content])).toEqual([
      [SESSION_ID, "Apa itu Ayat Kursi?"],
    ]);
  });
});
