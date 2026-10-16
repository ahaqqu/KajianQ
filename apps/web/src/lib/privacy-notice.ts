/**
 * The `/about` privacy notice's content: who processes a visitor's data, how
 * long it is kept, and how to erase it — the Art. 13(1)(e)
 * recipients/retention disclosure, rendered by `components/PrivacyNotice`.
 *
 * The repo's markdown registers are never imported at runtime (a production
 * bundle cannot read repo files), so the sibling data modules mirror them and
 * must be kept true to:
 *
 *   - `docs/GDPR-ARTICLE-30-RECORD.md` — the **source of truth** for the
 *     sub-processor register (§8) and the retention values (§6): the rows,
 *     tiers, verdicts and windows come from there, never from prose written
 *     here. The Tier column is a compliance field, not a cost note.
 *   - `adr/0043-netcup-vps-hosting-gdpr-posture.md` — the decisions behind
 *     those values: decision 3 the register rule, decision 4 retention.
 *   - `packages/infra/src/providers/models.json` — the register's
 *     machine-checkable shadow (`freeTier`, `personalDataAllowed`).
 *   - `apps/api/src/routes/auth.ts` — the erasure endpoint the notice points at.
 *
 * Two honesty rules run through these modules, and `privacy-notice.test.ts`
 * pins both:
 *
 *   1. **Status, not tense.** The serving path runs on netcup, and Cloudflare
 *      and Neon carry `no-serving-role` (their runtime and database are
 *      decommissioned — `docs/VPS-CUTOVER-RECORD.md` step 7; Cloudflare's R2
 *      stays as an at-rest provenance archive). Every row carries a status so
 *      the notice is never false, and a later posture change is a status edit,
 *      not a copy rewrite.
 *   2. **No claim without code.** A `current` retention row is enforced by code
 *      that exists today (the test reads it); a `planned` row names the ticket
 *      that implements it in its `planRef` and renders as planned. The erasure
 *      path is the endpoint that exists, with the missing UI control stated as
 *      a gap — never an invented affordance.
 *
 * This module is the single aggregation point (mirroring `lib/collections.ts`),
 * so each sibling stays inside the agentic-limits size cap.
 */

export {
  type ProcessorStatus,
  type ProcessorTier,
  type ProcessorVerdict,
  type RetentionItem,
  type RetentionStatus,
  type SubProcessor,
} from "./privacy-notice-types";

export {
  REGISTER_RULE,
  REGISTER_SOURCE,
  REGISTER_TRANSITION_NOTE,
  SUB_PROCESSORS,
} from "./privacy-notice-register";

export { RETENTION } from "./privacy-notice-retention";

export { CONTROLLER, ERASURE } from "./privacy-notice-erasure";

export { STORAGE } from "./privacy-notice-storage";
