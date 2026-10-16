# ADR-0019: The boundary gate scans migrations and SQL, not TypeScript alone

## Decision

1. **The scan covers `.sql` as well as `.ts*`,** and it scans the migration directory with the package sources. The domain-identifier rule applies to both languages; the vendor and DB-client rules apply to TypeScript only, because a DDL file legitimately contains SQL rather than a driver import.
2. **The domain-identifier pattern includes the Quran-verse vocabulary,** so an engine migration cannot encode a verse reference either.
3. **The DB-client pattern covers the coupling shapes a static import check misses** — a driver constructor, a pooled client, a dynamic import.
4. **The DB-client exemption is a named allowlist,** not a whole directory: the adapter's own integration test and the scripts that own migrations and probes.
5. **`bun run boundary` runs in the CI gate job,** so the boundary is PR-blocking rather than a local checklist item.

## Why

The gate reported zero violations while product-domain tables sat in an engine migration. A false negative is worse than no gate, because green is read as proof. The blind spot was the scanned file types: the rule the gate enforces claims to cover the engine's schema, and executable DDL is the engine's schema. A directory-wide exemption is the same class of hole — any later file in the directory bypasses all three rules at once.

Rejected: an exemption by directory; a regex over generic words such as _principle_ or _concept_, which are legitimate computer-science and NLP terms and would flood the gate with false positives. Ownership of those tables is enforced by where they live and by review.

## Consequences

- A product-owned or domain-owned table in the engine schema fails the gate with a pointer; those tables live in the app's migrations and the domain pack's migrations.
- Generic vocabulary stays unflagged by design, while the clearly domain-specific terms are enforced mechanically.
- **Revisit when** an engine file type carries executable schema without being `.sql` or TypeScript — the scan extends to it.
