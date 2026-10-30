/**
 * The pre-ingest snapshot gate (ADR-0038 decision 3): a store-writing ingestion
 * refuses to run unless a **verified** pre-ingest snapshot exists.
 *
 * The gate is a policy, not the verification itself. It takes the verifier as a
 * callback because the evidence lives outside this package — the portable dump
 * and its manifest are in the object store, and the live corpus counts come from
 * the database — and because the same policy must be provable without either.
 * The production verifier is `db:snapshot verify`, so "verified" here means what
 * it means there: the dump was re-downloaded, hashed against its manifest, and
 * the manifest's corpus counts matched the database this run is about to write.
 *
 * Three refusals are deliberate:
 *
 * - a missing, malformed or unverified label refuses the run, and the refusal
 *   carries the verifier's own reasons so the operator can act on them;
 * - the test escape refuses to *claim* a label: it allows the write but records
 *   that no snapshot was verified, so a report produced under it cannot be read
 *   as snapshot-backed evidence;
 * - a dry run verifies nothing and writes nothing, so it neither needs a
 *   snapshot nor records a label it never checked.
 */

/** The label grammar `db:snapshot` accepts: lowercase, digits and dashes. */
export const SNAPSHOT_LABEL_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

/** Why a label was refused before any verification was attempted. */
export function snapshotLabelProblem(label: string): string | null {
  if (label.trim() === "") return "no snapshot label was given";
  return SNAPSHOT_LABEL_RE.test(label)
    ? null
    : `snapshot label "${label}" must match ${SNAPSHOT_LABEL_RE.source} (lowercase, digits and dashes)`;
}

/** The verifier's answer: verified, or the reasons it is not. */
export type SnapshotVerdict = {
  readonly verified: boolean;
  readonly label: string;
  readonly reasons: readonly string[];
};

/**
 * Verify one snapshot label. The production implementation runs
 * `db:snapshot verify <label>`; a test injects its own verdict.
 */
export type VerifySnapshot = (label: string) => Promise<SnapshotVerdict>;

export type GateMode = "verified-snapshot" | "test-escape" | "dry-run";

/**
 * What the gate decided. `allowed` is the only field a write path may trust;
 * `mode` and `label` are what the report records, so a report can never imply a
 * verified snapshot it did not have.
 */
export type IngestGateDecision = {
  readonly allowed: boolean;
  readonly mode: GateMode;
  readonly label: string | null;
  readonly reasons: readonly string[];
};

/** A refused gate: the run stops before the archive is read or a row is written. */
export class IngestGateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestGateRefusal";
  }
}

export type GateRequest = {
  /** A dry run writes nothing, so it needs no snapshot and verifies none. */
  readonly dryRun: boolean;
  /** The explicit escape for a disposable database: writes without a snapshot. */
  readonly testAllowNoSnapshot: boolean;
  readonly label?: string;
  /** The verifier; the composition root supplies the `db:snapshot verify` one. */
  readonly verify: VerifySnapshot;
};

/** Decide whether this run may write, and record what the decision rests on. */
export async function resolveIngestGate(request: GateRequest): Promise<IngestGateDecision> {
  if (request.dryRun) {
    return {
      allowed: true,
      mode: "dry-run",
      label: null,
      reasons: ["dry run: no snapshot was verified and nothing will be written"],
    };
  }
  if (request.testAllowNoSnapshot) {
    return {
      allowed: true,
      mode: "test-escape",
      label: null,
      reasons: [
        "--test-allow-no-snapshot is set: this run writes without a verified pre-ingest snapshot. " +
          "It is only correct against a disposable database.",
      ],
    };
  }
  const label = request.label ?? "";
  const problem = snapshotLabelProblem(label);
  if (problem !== null) {
    return {
      allowed: false,
      mode: "verified-snapshot",
      label: null,
      reasons: [
        `${problem} — ADR-0038 refuses a store-writing ingest without a verified pre-ingest snapshot. ` +
          "Create one with `bun run db:snapshot create pre-ingest-<utc>`, verify it, then pass --snapshot <label>.",
      ],
    };
  }
  const verdict = await request.verify(label);
  if (!verdict.verified) {
    return {
      allowed: false,
      mode: "verified-snapshot",
      label,
      reasons: [
        `snapshot "${label}" is not verified:`,
        ...verdict.reasons.map((reason) => `  ${reason}`),
        "Run `bun run db:snapshot verify " + label + "` and fix every line above before writing.",
      ],
    };
  }
  return {
    allowed: true,
    mode: "verified-snapshot",
    label,
    reasons: [`snapshot "${label}" verified: dump hash and live corpus counts match its manifest`],
  };
}

/** Stop a write path whose decision is not `allowed`; the caller gets the reasons. */
export function assertIngestGate(decision: IngestGateDecision): void {
  if (decision.allowed) return;
  throw new IngestGateRefusal(
    ["refusing to write: no verified pre-ingest snapshot", ...decision.reasons].join("\n"),
  );
}
