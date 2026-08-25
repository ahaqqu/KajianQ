# ADR-0003: DIY LWW-element-set CRDT over Tinybase

**Status:** accepted  
**Date:** 2026-07-30

## Context

The docs claimed Tinybase MergeableStore sync, but the real code was a hand-rolled last-write-wins merge scattered across `packages/sync-protocol` and `apps/web/src/lib/` — two systems, one phantom. The merge also had a commutativity bug on exact-timestamp ties (`mergeNotes(a,b) ≠ mergeNotes(b,a)` for same-ms writes).

## Decision

Consolidate the custom per-record LWW-element-set CRDT with tombstones into `packages/local-first` (`@app/local-first`) as the only sync story. `tinybase` and `workbox-window` are removed from the dependency tree. The package is pure TypeScript: the API imports `mergeNotes`/`SCHEMA_VERSION` from the same module the client uses; the `/client` entrypoint holds the DOM-dependent parts (leader election, sync loop, persistence, migrations).

Hardening shipped with the consolidation:

- **Deterministic ties:** equal `updatedAt` resolves by serialized payload order — merge is commutative including exact ties.
- **Clock discipline:** each sync response carries `serverNow`; the client stamps future writes against `max(Date.now(), serverNow)`, so a skewed clock can neither lose nor win every merge.
- **Tombstones:** deletes strip payloads; tombstones older than 30 days are garbage-collected after a successful sync.

## Limitations

- **Whole-record granularity.** Two clients editing the same record concurrently keep only one side's record — even when they touched different fields. Acceptable for single-user data; wrong for collaborative editing.
- **Wall-clock dependence.** Mitigated, not eliminated, by the server-bias floor.
- **GC horizon.** Local GC only bounds IndexedDB growth — every collected tombstone is server-acknowledged and the server keeps its own tombstones. Any client that syncs at least monthly never resurrects a collected delete.

## Adoption trigger

Adopt a field-level CRDT library (Automerge, Yjs class) when shared records need concurrent field-level merging — that requirement, not record count, is the trigger.

## Consequences

- Property tests (fast-check) prove idempotency, commutativity including ties, associativity, delete-wins, mapper round-trip, and that GC never resurrects or loses alive rows.
- One `note-mapper` module is the single `NoteRow ↔ Note` truth for client and server.
