import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_VERSION, SCHEMA_VERSION } from "@app/local-first";
import { apiFetch } from "./api";
import {
  listAlive,
  loadState,
  pushPull,
  removeNote,
  saveState,
  upsertNote,
  type NotesState,
} from "./notes-store";

vi.mock("./api", () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";
const ID_TOMB = "123e4567-e89b-42d3-a456-426614174002";

/** Minimal in-memory IndexedDB fake: one store, microtask-async requests. */
function stubIndexedDB() {
  let data: unknown;
  vi.stubGlobal("indexedDB", {
    open: () => {
      const db = {
        objectStoreNames: { contains: () => false },
        createObjectStore: () => ({}),
        transaction: () => {
          const tx = {
            objectStore: () => ({
              get: () => {
                const req = {
                  result: undefined as unknown,
                  onsuccess: null as null | (() => void),
                  onerror: null as null | (() => void),
                };
                queueMicrotask(() => {
                  req.result = data;
                  req.onsuccess?.();
                });
                return req;
              },
              put: (value: unknown) => {
                data = value;
              },
            }),
            oncomplete: null as null | (() => void),
            onerror: null as null | (() => void),
          };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        },
        close: () => {},
      };
      const req = {
        result: db,
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onupgradeneeded: null as null | (() => void),
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  });
}

function emptyState(clockFloor?: number): NotesState {
  return { schemaVersion: SCHEMA_VERSION, notes: [], clockFloor };
}

function syncResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("notes-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubIndexedDB();
  });

  it("loads the default empty state when nothing is persisted", async () => {
    const s = await loadState();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.notes).toEqual([]);
  });

  it("round-trips state through IndexedDB", async () => {
    const state: NotesState = {
      schemaVersion: SCHEMA_VERSION,
      notes: [{ id: ID_A, title: "t", body: "b", updatedAt: 100 }],
      clockFloor: 50,
    };
    await saveState(state);
    expect(await loadState()).toEqual(state);
  });

  it("upsertNote stamps at the clock floor and persists", async () => {
    const next = await upsertNote(emptyState(1_000), {
      id: ID_A,
      title: "a",
      body: "",
      updatedAt: 10,
    });
    expect(next.notes[0]?.updatedAt).toBe(1_000);
    expect((await loadState()).notes).toHaveLength(1);
  });

  it("removeNote writes a payload-stripped tombstone hidden from listAlive", async () => {
    const withNote = await upsertNote(emptyState(), {
      id: ID_A,
      title: "a",
      body: "secret",
      updatedAt: 10,
    });
    expect(listAlive(withNote)).toEqual([
      { id: ID_A, title: "a", body: "secret", updatedAt: 10, deleted: false },
    ]);
    const after = await removeNote(withNote, ID_A);
    expect(after.notes[0]?.deleted).toBe(true);
    expect(after.notes[0]?.title).toBe("");
    expect(after.notes[0]?.body).toBe("");
    expect(listAlive(after)).toEqual([]);
  });

  it("pushPull sends the sync wire shape", async () => {
    mockedApiFetch.mockResolvedValue(
      syncResponse({ schemaVersion: SCHEMA_VERSION, serverNow: 0, notes: [] }),
    );
    const state: NotesState = {
      schemaVersion: SCHEMA_VERSION,
      notes: [{ id: ID_A, title: "a", body: "b", updatedAt: 100 }],
    };
    await pushPull(state, "tok");
    const call = mockedApiFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [path, init] = call!;
    expect(path).toBe("/sync");
    expect(init?.method).toBe("POST");
    expect(init?.token).toBe("tok");
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: SCHEMA_VERSION,
      clientVersion: CLIENT_VERSION,
      notes: [
        { id: ID_A, title: "a", body: "b", updatedAt: 100, deleted: false },
      ],
    });
  });

  it("pushPull throws schema_mismatch on 409", async () => {
    mockedApiFetch.mockResolvedValue(new Response(null, { status: 409 }));
    await expect(pushPull(emptyState(), "tok")).rejects.toThrow(
      "schema_mismatch",
    );
  });

  it("pushPull throws on other non-ok statuses", async () => {
    mockedApiFetch.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(pushPull(emptyState(), "tok")).rejects.toThrow("sync_500");
  });

  it("pushPull rejects an invalid response body", async () => {
    mockedApiFetch.mockResolvedValue(syncResponse({ schemaVersion: 0 }));
    await expect(pushPull(emptyState(), "tok")).rejects.toThrow();
  });

  it("pushPull merges server notes, raises the clock floor, GCs old tombstones, and persists", async () => {
    const serverNow = Date.now() + 60_000;
    const oldTombstone = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const state: NotesState = {
      schemaVersion: SCHEMA_VERSION,
      notes: [
        { id: ID_A, title: "keep", body: "", updatedAt: 100 },
        { id: ID_TOMB, title: "", body: "", updatedAt: oldTombstone, deleted: true },
      ],
      clockFloor: 10,
    };
    mockedApiFetch.mockResolvedValue(
      syncResponse({
        schemaVersion: SCHEMA_VERSION,
        serverNow,
        notes: [
          { id: ID_B, title: "server", body: "s", updatedAt: serverNow, deleted: false },
        ],
      }),
    );
    const next = await pushPull(state, "tok");
    expect(next.clockFloor).toBe(serverNow);
    expect(next.notes.some((r) => r.id === ID_A)).toBe(true);
    expect(next.notes.some((r) => r.id === ID_B)).toBe(true);
    expect(next.notes.some((r) => r.id === ID_TOMB)).toBe(false);
    expect(await loadState()).toEqual(next);
  });
});
