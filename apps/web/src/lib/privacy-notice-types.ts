import type { Localized } from "./localized";

/**
 * The privacy notice's content model (#179, GDPR-C): the shapes the register,
 * the retention table, and the erasure card are declared with, plus the closed
 * vocabularies the notice renders as labels. Split from the data
 * (`privacy-notice-register.ts`, `privacy-notice-retention.ts`) so each module
 * stays inside the agentic-limits size cap, mirroring `collections-types.ts`.
 *
 * The values themselves are ADR-0043's (decisions 3 and 4) and are checked
 * against it by the notice's drift guards in `privacy-notice.test.ts`.
 */

/**
 * When a vendor's row describes the processing. `current` is serving traffic
 * today, `transition` is in use today but narrowed or retired at the netcup
 * cutover, `planned` is the destination and is not in use yet, and
 * `no-serving-role` is a catalogued or bench-only vendor that carries no
 * serving traffic (personal data never reaches it in the live path).
 */
export type ProcessorStatus = "current" | "transition" | "planned" | "no-serving-role";

/** The register's Tier column: a compliance field, not a cost note. */
export type ProcessorTier = "paid" | "free";

/** The register's personal-data verdict for the row's tier. */
export type ProcessorVerdict = "permitted" | "not-for-personal-data";

export type SubProcessor = {
  id: string;
  /** The vendor's registered name — a legal/brand name, never translated. */
  name: string;
  status: ProcessorStatus;
  /** The register's Role column. */
  role: Localized;
  /** The register's "Personal data seen" column. */
  personalData: Localized;
  tier: ProcessorTier;
  verdict: ProcessorVerdict;
  /** A register caveat that must travel with the row (e.g. the free-tier rule). */
  note?: Localized;
};

/** `current` is code that exists today; `planned` names its ticket in `planRef`. */
export type RetentionStatus = "current" | "planned";

export type RetentionItem = {
  id: string;
  status: RetentionStatus;
  /** What is kept. */
  what: Localized;
  /** The window, or the trigger that ends it. */
  window: Localized;
  /** In plain language, what enforces it — the code or config behind the claim. */
  enforcedBy: Localized;
  /** The registered ticket that implements a `planned` row (never on a `current` one). */
  planRef?: string;
};
