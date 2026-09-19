/**
 * The `/about` privacy notice's content (#179, GDPR-C): who processes a
 * visitor's data, how long it is kept, and how to erase it — the Art. 13(1)(e)
 * recipients/retention disclosure, rendered by `components/PrivacyNotice`.
 *
 * The repo's markdown registers are never imported at runtime (a production
 * bundle cannot read repo files), so the sibling data modules mirror them and
 * must be kept true to:
 *
 *   - `adr/0043-netcup-vps-hosting-gdpr-posture.md` — decision 3 (the
 *     sub-processor register) and decision 4 (the retention values). ADR-0043
 *     is the **source of truth**: the rows, tiers, and verdicts come from
 *     there, never from prose written here. The Tier column is a compliance
 *     field, not a cost note.
 *   - `docs/GDPR-ARTICLE-30-RECORD.md` — the Art. 30 rendering of the same
 *     values (§2 controller, §6 retention, §8 recipients).
 *   - `packages/infra/src/providers/models.json` — the register's
 *     machine-checkable shadow (`freeTier`, `personalDataAllowed`).
 *   - `apps/api/src/routes/auth.ts` — the erasure endpoint the notice points at.
 *
 * Two honesty rules run through these modules, and `privacy-notice.test.ts`
 * pins both:
 *
 *   1. **Status, not tense.** The VPS migration (#181) has not happened: today
 *      the API runs on Cloudflare Workers and the database on Neon. Every row
 *      therefore carries a status — the destination (netcup) is `planned`, the
 *      vendors in use today are `transition` or `current`, and a row with no
 *      serving role says so. The notice is never false today and never needs a
 *      rewrite at cutover beyond flipping a row's status — a data edit, not a
 *      copy edit.
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
